#!/bin/bash
# pretend editor: append a line, record invocation
echo "EDITED-BY-FAKE-EDITOR" >> "$1"
echo "{\"event\":\"fake-editor\",\"file\":\"$1\",\"tty\":\"$(tty 2>/dev/null)\"}" >> "${SPIKE_LOG:-/tmp/spike-plugin.log}"
exit 0
