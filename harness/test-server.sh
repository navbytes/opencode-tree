#!/bin/bash
H=$(cd "$(dirname "$0")" && pwd)
: > $H/requests.jsonl; : > $H/spike-plugin.log
B="http://127.0.0.1:4096"; D="?directory=$H/project"; J='content-type: application/json'
SID=$(curl -s -X POST "$B/session$D" -H "$J" -d '{"title":"spike-b"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])'); echo "session $SID"
echo "--- turn 1 (tool call expected)"; curl -s -m 90 -X POST "$B/session/$SID/message$D" -H "$J" -d '{"parts":[{"type":"text","text":"run the tool"}]}' > $H/t1.json; python3 -c "import json; d=json.load(open('$H/t1.json')); print('finish',d['info'].get('finish'), 'parts', [p['type'] for p in d['parts']])"
echo "--- turn 2 [branch-b]"; curl -s -m 90 -X POST "$B/session/$SID/message$D" -H "$J" -d '{"parts":[{"type":"text","text":"second turn [branch-b]"}]}' > $H/t2.json; python3 -c "import json; d=json.load(open('$H/t2.json')); print('model', d['info']['providerID'], d['info']['modelID'], 'finish', d['info'].get('finish'))"
echo "--- provider requests (model, tool messages)"; python3 - <<PY
import json
for line in open("$H/requests.jsonl"):
    r=json.loads(line); ms=r["body"]["messages"]
    tools=[m for m in ms if m.get("role")=="tool"]
    print(r["model"], "msgs", len(ms), "tool msgs:", [ (str(t.get("content"))[:70]) for t in tools])
PY
echo "--- plugin log"; cut -c1-200 $H/spike-plugin.log
echo "--- (c) metadata round-trip + fork"; curl -s -X PATCH "$B/session/$SID$D" -H "$J" -d '{"metadata":{"ctree":{"treeId":"t1","parentSessionID":null,"anchorMessageID":null}}}' | python3 -c 'import sys,json; print("update ->", json.load(sys.stdin).get("metadata"))'
MID=$(python3 -c "import json; print(json.load(open('$H/t2.json'))['info']['parentID'])"); echo "fork at user msg $MID"
FORK=$(curl -s -X POST "$B/session/$SID/fork$D" -H "$J" -d "{\"messageID\":\"$MID\"}"); echo "$FORK" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("fork ->", d["id"], "title:", d["title"], "parentID:", d.get("parentID"), "metadata:", d.get("metadata"))'
FID=$(echo "$FORK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])'); curl -s "$B/session/$FID/message$D" | python3 -c 'import sys,json; ms=json.load(sys.stdin); print("fork messages:", [(m["info"]["role"], [p["type"] for p in m["parts"]]) for m in ms])'
echo "--- serve.log tail"; tail -3 $H/serve.log | cut -c1-200
