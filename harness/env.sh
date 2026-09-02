# source this: isolates OpenCode's XDG dirs under harness/env and puts the local opencode binary on PATH
H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export XDG_DATA_HOME=$H/env/data XDG_CONFIG_HOME=$H/env/config XDG_STATE_HOME=$H/env/state XDG_CACHE_HOME=$H/env/cache
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_PRUNE=1
export PATH=$H/node_modules/.bin:$PATH
mkdir -p $H/env/data $H/env/config $H/env/state $H/env/cache
