# Scripts

## ssh-setup.sh

Generates an SSH key pair and configures `~/.ssh/config` for passwordless access to your homebridge device.

```bash
bash scripts/ssh-setup.sh <pi-ip-or-hostname> [pi-user]
# Example
bash scripts/ssh-setup.sh 192.168.1.50 pi
```

After running, connect with `ssh homebridge`.

## ssh-deploy.sh

Builds the project and deploys the output to the homebridge device via `rsync` over SSH. Run `ssh-setup.sh` first.

```bash
bash scripts/ssh-deploy.sh [host] [user] [remote-path]
# Example (uses 'homebridge' alias by default)
bash scripts/ssh-deploy.sh
```
