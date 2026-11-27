For years I ran one-off scripts on servers the quick way: paste the script into a pastebin, then curl it into bash on the server. Then one server couldn't verify the paste site's certificate. The script's upload of a freshly generated SSH key failed silently, and the next line would have deleted the only copy. That was the push I needed.

So I built shellpin: paste a script in your browser, get one command, run it on any server. Nothing is uploaded or stored anywhere.

What you can do:
🔹 Paste Bash, sh, PowerShell or Python; the language is detected for you
🔹 Fill in only the arguments the script actually takes: it reads usage text, case statements, getopts, PowerShell param() and Python argparse, and turns them into dropdowns, checkboxes and sample values
🔹 Run on the server in front of you, in a Kubernetes pod, in a Docker container, or across several servers over SSH
🔹 Set an expiry (one hour to one year); after that the command refuses to run
🔹 Lock it to hosts like prod-db-*, so pasting into the wrong terminal does nothing
🔹 Have secrets like DB_PASSWORD asked for on the server with hidden typing, so they never land in the command, the chat or shell history
🔹 See danger warnings before you copy (rm -rf on a variable, mkfs, firewall flushes, userdel), plus a preview command that shows the script on the server instead of running it
🔹 Hand over an SSH key or kubeconfig as a link, encrypted with a passphrase, with no upload

How it works: the script is compressed into the command itself, so the server needs no internet access and no file is left behind. The whole script is decoded before anything runs, so a cut-short paste runs nothing. A short fingerprint at the start of the command lets a colleague confirm they have the same script.

How it's built:
⚙️ Static site on GitHub Pages, zero dependencies, no server and no account
🔒 Content-Security-Policy blocks every network request from the page
🧪 Tests run the generated commands in real bash, sh, PowerShell and Python, and through kubectl, docker and ssh, and check that compacting a script never changes its output
🚀 CI checks scripts with ShellCheck and deploys to Pages on every push

An honest caveat: the command decodes and runs a script, the same pattern some malware uses, so endpoint security tools may flag it on monitored machines. The README covers who this fits and who should stick with Ansible or SSM.

Try it: https://yousafkhamza.github.io/shellpin/
Source: https://github.com/yousafkhamza/shellpin

How do you get one-off scripts onto servers today?

#DevOps #DevSecOps #Linux #PowerShell #Kubernetes #SRE #OpenSource #GitHubActions
