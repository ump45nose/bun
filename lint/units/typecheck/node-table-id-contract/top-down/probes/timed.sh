#!/bin/bash
# Runs a command and prints wall, user and system time of the command and of its children.
s=$(date +%s.%N)
"$@" > /tmp/ntc-td/timed.out 2>&1
rc=$?
e=$(date +%s.%N)
t=( $(times | tail -1) )
grep -E "Finished|error" /tmp/ntc-td/timed.out | head -3
echo "rc=$rc wall $(echo "$e - $s" | bc) s; children user ${t[0]} sys ${t[1]}"
