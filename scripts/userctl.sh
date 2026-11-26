#!/bin/bash
# @description Create, reset or delete SSH users with PEM/password login, sudo and a protected SFTP folder
# @usage create|reset|delete <username> [pem|password|both] [yes|no] [yes|no]
# @expires 2027-11-26
set -e

ACTION="$1"
USER="$2"
AUTH="$3"
SUDO_ACCESS="$4"
SFTP_ACCESS="$5"

KEY_DIR="/home/pem-files"
KEY_FILE="$KEY_DIR/$USER.pem"

SSHD="/etc/ssh/sshd_config"

USER_HOME="/home/$USER"
SFTP_DIR="$USER_HOME/sftp"
SFTP_DATA="$SFTP_DIR/data"

LOG_FILE="/var/log/userctl.log"

SFTP_GROUP="sftpusers"

########################################
# USAGE
########################################

usage() {

  echo "Usage:"
  echo "  $0 create|reset|delete <username> [pem|password|both] [yes|no] [yes|no]"
  echo ""
  echo "Examples:"
  echo "  $0 create admin both yes yes"
  echo "  $0 create devuser pem no yes"
  echo ""

  exit 1
}

[[ -z "$ACTION" || -z "$USER" ]] && usage

########################################
# LOGGING
########################################

log_action() {

  echo "$(date) ACTION=$ACTION USER=$USER AUTH=$AUTH SUDO=$SUDO_ACCESS SFTP=$SFTP_ACCESS" >> "$LOG_FILE"
}

########################################
# NORMALIZE INPUTS
########################################

normalize_inputs() {

  case "$AUTH" in
    1|pem) AUTH="1" ;;
    2|password) AUTH="2" ;;
    3|both) AUTH="3" ;;
  esac

  case "$SUDO_ACCESS" in
    y|yes) SUDO_ACCESS="y" ;;
    n|no) SUDO_ACCESS="n" ;;
  esac

  case "$SFTP_ACCESS" in
    y|yes) SFTP_ACCESS="y" ;;
    n|no) SFTP_ACCESS="n" ;;
  esac
}

########################################
# INTERACTIVE INPUT
########################################

select_auth() {

  if [[ -n "$AUTH" && -n "$SUDO_ACCESS" && -n "$SFTP_ACCESS" ]]; then

    normalize_inputs

    return
  fi

  echo ""
  echo "Select authentication method:"
  echo "1) PEM only"
  echo "2) Password only"
  echo "3) PEM + Password"
  echo ""

  read -r -p "Enter choice (1/2/3): " AUTH < /dev/tty
  echo ""

  read -r -p "Grant sudo/root access? (y/n): " SUDO_ACCESS < /dev/tty
  echo ""

  read -r -p "Enable SFTP folder? (y/n): " SFTP_ACCESS < /dev/tty
  echo ""

  normalize_inputs
}

########################################
# PREPARE PEM DIR
########################################

prepare_key_dir() {

  mkdir -p "$KEY_DIR"

  chmod 700 "$KEY_DIR"
}

########################################
# HAND OVER PEM
########################################

# Packs the key into a shellpin file link (same format as share.sh). The key
# goes inside the link after "#", which is never sent to any server, so
# nothing is uploaded and no internet access is needed. The page turns the
# link back into a <user>.pem download.
#   PEM_LINK_HOURS=24   how long the page accepts the link (max 8760)
#   PEM_PASSPHRASE=no   skip the passphrase (default: encrypt when openssl >= 1.1.1)
SHELLPIN_URL="${SHELLPIN_URL:-https://yousafkhamza.github.io/shellpin}"

upload_pem() {

  local pass="" data="" expires ossl="" bin hours="${PEM_LINK_HOURS:-24}"

  [[ "$hours" =~ ^[0-9]+$ ]] && (( hours >= 1 && hours <= 8760 )) || hours=24
  expires=$(( $(date +%s) + hours * 3600 ))

  # -pbkdf2 needs OpenSSL 1.1.1+ (Amazon Linux 2: `yum install -y openssl11`).
  if [[ "${PEM_PASSPHRASE:-auto}" != "no" ]]; then
    for bin in openssl openssl11 openssl3; do
      if command -v "$bin" >/dev/null && "$bin" enc -aes-256-cbc -pbkdf2 -iter 1 -md sha256 -pass pass:x -in /dev/null >/dev/null 2>&1; then
        ossl="$bin"; break
      fi
    done
    if [[ -n "$ossl" ]]; then
      pass=$("$ossl" rand -hex 12)
    else
      echo "Note: openssl is too old for a passphrase (yum install -y openssl11); the link below has none."
    fi
  fi

  if data=$(set -o pipefail
      { printf 'shellpin-file 1\nname: %s\nexpires: %s\n\n' "$USER.pem" "$expires"; cat "$KEY_FILE"; } \
        | gzip -9n \
        | if [[ -n "$pass" ]]; then
            SHELLPIN_PASS="$pass" "$ossl" enc -aes-256-cbc -pbkdf2 -iter 250000 -md sha256 -salt -pass env:SHELLPIN_PASS
          else
            cat
          fi \
        | base64 | tr -d '\n=' | tr '+/' '-_') && [[ -n "$data" ]]; then

    echo ""
    echo "PEM link (opens for ${hours}h; nothing was uploaded):"
    echo "${SHELLPIN_URL%/}/f.html#f1.$([[ -n "$pass" ]] && echo p || echo z).$data"

    if [[ -n "$pass" ]]; then
      echo ""
      echo "Passphrase: $pass"
      echo "Send the passphrase through a different channel than the link."
    fi

  else

    # The key file is deleted right after this; never lose it silently.
    echo ""
    echo "Could not build the PEM link. Copy the private key below now; it is deleted from this server next."
    echo ""
    cat "$KEY_FILE"
  fi
}

########################################
# RELOAD SSH
########################################

reload_ssh() {

  systemctl reload ssh 2>/dev/null || systemctl reload sshd
}

########################################
# SSH MATCH BLOCK
########################################

apply_ssh_match() {

  sed -i "/Match User $USER/,/^$/d" "$SSHD"

  cat <<EOT >> "$SSHD"

Match User $USER
    PubkeyAuthentication $PEM_ENABLED
    PasswordAuthentication $PASS_ENABLED
    AllowTcpForwarding no
    X11Forwarding no
    PermitTTY yes
EOT

  sshd -t || {

    echo "SSHD config error"

    exit 1
  }

  reload_ssh
}

########################################
# INSTALL INCRON
########################################

install_incron() {

  ########################################
  # ALREADY INSTALLED
  ########################################

  if command -v incrond >/dev/null 2>&1 || command -v incron >/dev/null 2>&1; then

    echo "incron already installed"

    return
  fi

  echo "Installing incron..."

  ########################################
  # AMAZON LINUX
  ########################################

  if grep -qi "Amazon Linux" /etc/os-release; then

    echo "Detected Amazon Linux"

    ########################################
    # AMAZON LINUX 2023
    ########################################

    if command -v dnf >/dev/null 2>&1; then

      dnf install -y incron || {

        dnf install -y epel-release || true

        dnf install -y incron
      }

    ########################################
    # AMAZON LINUX 2
    ########################################

    else

      amazon-linux-extras install epel -y || true

      yum install -y epel-release || true

      yum install -y incron

    fi

  ########################################
  # RHEL/CENTOS/ROCKY/ALMA
  ########################################

  elif [[ -f /etc/redhat-release ]]; then

    if command -v dnf >/dev/null 2>&1; then

      dnf install -y epel-release || true

      dnf install -y incron

    else

      yum install -y epel-release || true

      yum install -y incron

    fi

  ########################################
  # UBUNTU/DEBIAN
  ########################################

  elif [[ -f /etc/debian_version ]]; then

    apt update -y

    DEBIAN_FRONTEND=noninteractive apt install -y incron

  else

    echo "Unsupported OS"

    cat /etc/os-release

    exit 1
  fi

  ########################################
  # ENABLE SERVICE
  ########################################

  if systemctl list-unit-files | grep -q "^incrond.service"; then

    systemctl enable --now incrond

  elif systemctl list-unit-files | grep -q "^incron.service"; then

    systemctl enable --now incron

  fi

  echo "incron installed successfully"
}

########################################
# SETUP SFTP
########################################

setup_sftp_permissions() {

  mkdir -p "$SFTP_DIR"

  ########################################
  # ROOT/SUDO USER
  ########################################

  if [[ "$SUDO_ACCESS" == "y" ]]; then

    chown -R "$USER:$USER" "$SFTP_DIR"

    chmod 755 "$SFTP_DIR"

  else

    ########################################
    # RESTRICTED USER
    ########################################

    groupadd -f "$SFTP_GROUP"

    usermod -aG "$SFTP_GROUP" "$USER"

    mkdir -p "$SFTP_DATA"

    chown root:root "$SFTP_DIR"

    chmod 755 "$SFTP_DIR"

    chown "$USER:$SFTP_GROUP" "$SFTP_DATA"

    chmod 775 "$SFTP_DATA"

    chattr +i "$SFTP_DIR" 2>/dev/null || true

  fi
}

########################################
# SETUP INCRON PROTECTION
########################################

setup_incron_protection() {

  ########################################
  # ONLY FOR NON-SUDO USERS
  ########################################

  [[ "$SUDO_ACCESS" == "y" ]] && return

  install_incron

  ########################################
  # PROTECTION SCRIPT
  ########################################

  cat > /usr/local/bin/sftp-protect.sh <<'EOT'
#!/bin/bash

FILE="$1"

sleep 1

if [[ -f "$FILE" ]]; then

    chown root:sftpusers "$FILE" 2>/dev/null || true

    chmod 664 "$FILE" 2>/dev/null || true

    chattr +i "$FILE" 2>/dev/null || true

fi
EOT

  chmod +x /usr/local/bin/sftp-protect.sh

  ########################################
  # ENABLE ROOT
  ########################################

  touch /etc/incron.allow

  if ! grep -q "^root$" /etc/incron.allow; then

    echo "root" >> /etc/incron.allow
  fi

  ########################################
  # USER RULE
  ########################################

  RULE_FILE="/etc/incron.d/${USER}-sftp"

  cat > "$RULE_FILE" <<EOT
$SFTP_DATA IN_CREATE /usr/local/bin/sftp-protect.sh \$@/\$#
EOT

  ########################################
  # RESTART SERVICE
  ########################################

  if systemctl list-unit-files | grep -q "^incrond.service"; then

    systemctl restart incrond

  elif systemctl list-unit-files | grep -q "^incron.service"; then

    systemctl restart incron

  fi

  echo "incron protection enabled for $USER"
}

########################################
# CREATE USER
########################################

create_user() {

  if id "$USER" &>/dev/null; then

    echo "User exists"

    exit 1
  fi

  select_auth

  useradd -m -s /bin/bash "$USER"

  ########################################
  # SUDO
  ########################################

  if [[ "$SUDO_ACCESS" == "y" ]]; then

    echo "$USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$USER"

  else

    echo "$USER ALL=(ALL) !ALL" > "/etc/sudoers.d/$USER"

  fi

  chmod 440 "/etc/sudoers.d/$USER"

  ########################################
  # SSH
  ########################################

  mkdir -p "$USER_HOME/.ssh"

  chmod 700 "$USER_HOME/.ssh"

  chown -R "$USER:$USER" "$USER_HOME/.ssh"

  PASS=""

  PEM_ENABLED="no"
  PASS_ENABLED="no"

  ########################################
  # PEM AUTH
  ########################################

  if [[ "$AUTH" == "1" || "$AUTH" == "3" ]]; then

    PEM_ENABLED="yes"

    prepare_key_dir

    ssh-keygen -t rsa -b 4096 -f "$KEY_FILE" -N ""

    cat "$KEY_FILE.pub" > "$USER_HOME/.ssh/authorized_keys"

    chmod 600 "$USER_HOME/.ssh/authorized_keys"

    chown "$USER:$USER" "$USER_HOME/.ssh/authorized_keys"

    upload_pem

    rm -f "$KEY_FILE"
  fi

  ########################################
  # PASSWORD AUTH
  ########################################

  if [[ "$AUTH" == "2" || "$AUTH" == "3" ]]; then

    PASS_ENABLED="yes"

    PASS=$(openssl rand -base64 12)

    echo "$USER:$PASS" | chpasswd
  fi

  ########################################
  # SFTP
  ########################################

  if [[ "$SFTP_ACCESS" == "y" ]]; then

    setup_sftp_permissions

    setup_incron_protection
  fi

  ########################################
  # SSH CONFIG
  ########################################

  apply_ssh_match

  log_action

  ########################################
  # OUTPUT
  ########################################

  echo ""
  echo "======================================"
  echo "USER CREATED"
  echo "======================================"

  echo "Username : $USER"

  [[ -n "$PASS" ]] && echo "Password : $PASS"

  if [[ "$SUDO_ACCESS" == "y" ]]; then
    echo "Sudo     : Enabled"
  else
    echo "Sudo     : Disabled"
  fi

  if [[ "$SFTP_ACCESS" == "y" ]]; then

    if [[ "$SUDO_ACCESS" == "y" ]]; then

      echo "SFTP     : $SFTP_DIR"
      echo "Access   : Full"

    else

      echo "SFTP     : $SFTP_DATA"
      echo "Access   : Upload/Edit only"
      echo "Delete   : Restricted"

    fi
  fi

  echo "======================================"
}

########################################
# RESET USER
########################################

reset_user() {

  id "$USER" &>/dev/null || {

    echo "User not found"

    exit 1
  }

  select_auth

  PASS=""

  PEM_ENABLED="no"
  PASS_ENABLED="no"

  rm -f "$USER_HOME/.ssh/authorized_keys"

  ########################################
  # PEM RESET
  ########################################

  if [[ "$AUTH" == "1" || "$AUTH" == "3" ]]; then

    PEM_ENABLED="yes"

    prepare_key_dir

    rm -f "$KEY_FILE" "$KEY_FILE.pub"

    ssh-keygen -t rsa -b 4096 -f "$KEY_FILE" -N ""

    cat "$KEY_FILE.pub" > "$USER_HOME/.ssh/authorized_keys"

    chmod 600 "$USER_HOME/.ssh/authorized_keys"

    chown "$USER:$USER" "$USER_HOME/.ssh/authorized_keys"

    upload_pem

    rm -f "$KEY_FILE"
  fi

  ########################################
  # PASSWORD RESET
  ########################################

  if [[ "$AUTH" == "2" || "$AUTH" == "3" ]]; then

    PASS_ENABLED="yes"

    PASS=$(openssl rand -base64 12)

    echo "$USER:$PASS" | chpasswd
  fi

  ########################################
  # SFTP
  ########################################

  if [[ "$SFTP_ACCESS" == "y" ]]; then

    setup_sftp_permissions

    setup_incron_protection
  fi

  apply_ssh_match

  log_action

  echo ""
  echo "======================================"
  echo "USER RESET"
  echo "======================================"

  echo "Username : $USER"

  [[ -n "$PASS" ]] && echo "New Password : $PASS"

  echo "======================================"
}

########################################
# DELETE USER
########################################

delete_user() {

  if id "$USER" &>/dev/null; then

    echo "Killing active processes..."

    pkill -u "$USER" 2>/dev/null || true

    echo "Deleting user..."

    ########################################
    # REMOVE IMMUTABLE FLAGS
    ########################################

    if [[ -d "$USER_HOME" ]]; then

      find "$USER_HOME" -exec chattr -i {} \; 2>/dev/null || true

    fi

    ########################################
    # REMOVE INCRON RULE
    ########################################

    rm -f "/etc/incron.d/${USER}-sftp"

    ########################################
    # DELETE USER
    ########################################

    userdel -r "$USER"

  else

    echo "User does not exist"

  fi

  rm -f "$KEY_FILE" "$KEY_FILE.pub"

  rm -f "/etc/sudoers.d/$USER"

  sed -i "/Match User $USER/,/^$/d" "$SSHD"

  sshd -t && reload_ssh

  log_action

  echo ""
  echo "User deleted: $USER"
}

########################################
# MAIN
########################################

case "$ACTION" in

  create)

    create_user

    ;;

  reset)

    reset_user

    ;;

  delete)

    delete_user

    ;;

  *)

    usage

    ;;

esac
