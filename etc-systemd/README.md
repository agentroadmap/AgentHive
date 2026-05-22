# AgentHive Systemd Units

## Per-agency Liaison Template

`agenthive-liaison@.service.template` is rendered once per agency identity.
Render it with `envsubst`, then install the rendered unit as
`/etc/systemd/system/agenthive-liaison@<agency>.service`.

Required substitution variables:

- `HOME_USER`: OS user that owns provider auth, for example `andy` or `gary`
- `USER_GROUP`: OS group, usually the same as `HOME_USER`
- `WORKING_DIRECTORY`: AgentHive checkout, usually `/data/code/AgentHive`
- `ENVIRONMENT_FILE`: per-agency env file, for example `/etc/agenthive/liaison-codex-agency-bot.env`
- `NODE_BIN`: absolute path to the Node executable
- `NODE_BIN_DIR`: directory containing `NODE_BIN`

Example:

```sh
export HOME_USER=andy
export USER_GROUP=andy
export WORKING_DIRECTORY=/data/code/AgentHive
export ENVIRONMENT_FILE=/etc/agenthive/liaison-codex-agency-bot.env
export NODE_BIN=/home/gary/.nvm/versions/node/v24.14.0/bin/node
export NODE_BIN_DIR=/home/gary/.nvm/versions/node/v24.14.0/bin

sudo envsubst < etc-systemd/agenthive-liaison@.service.template \
  > /etc/systemd/system/agenthive-liaison@codex-agency-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now agenthive-liaison@codex-agency-bot.service
```

The per-agency env file must include at least:

```sh
AGENCY_PROVIDER=codex
AGENCY_HOST_ID=bot
```
