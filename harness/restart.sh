#!/bin/bash
# restart mock provider + opencode serve with the spike env. usage: restart.sh [MOCK_TOOL=0|1]
H=$(cd "$(dirname "$0")" && pwd)
pkill -f "[o]pencode serve" 2>/dev/null; pkill -f "[m]ock-provider.mjs" 2>/dev/null; sleep 1
cd $H && (MOCK_TOOL=${1:-1} MOCK_LOG=$H/requests.jsonl nohup node mock-provider.mjs > $H/mock.log 2>&1 &)
cd $H/project && (SPIKE_LOG=$H/spike-plugin.log nohup opencode serve --port 4096 --hostname 127.0.0.1 > $H/serve.log 2>&1 &)
for i in $(seq 1 40); do curl -s -m 2 http://127.0.0.1:4096/global/health >/dev/null 2>&1 && break; sleep 1; done
curl -s -m 5 http://127.0.0.1:4096/global/health; echo
