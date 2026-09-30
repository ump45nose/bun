#!/bin/sh
cd /tmp/c2td/ws || exit 1
L=/tmp/c2td/logs
export CARGO_TERM_COLOR=never
( cargo clippy -p bun_ast -p bun_lint --all-targets --no-deps --message-format=short; echo "clippy-exit=$?" ) > $L/06-clippy.log 2>&1
( cargo fmt -p bun_lint -- --check; echo "fmt-lint-exit=$?" ) > $L/07-fmt.log 2>&1
( cargo check -p bun_lint --message-format=short; echo "check-lib-only-exit=$?" ) > $L/08-check-lib.log 2>&1
echo done > $L/run2.done
