# pi-config
Opinionated minimal configuration for pi coding agent.

### Quick Start
*Tested on Ubuntu 24.04: may require npm to already be installed*

```bash
curl -fsSL https://get.pnpm.io/install.sh | bash -
source ~/.bashrc
pnpm runtime set node 24 -g
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent
git clone --recurse-submodules git@github.com:FieldSwan/pi-config.git ~/.pi
# optional: cd to desired context, e.g. `cd ~/Projects/xyz`
pi
```

Then in the pi cli:
```bash
/login
```
