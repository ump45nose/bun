//! Ported from ESLint lib/rules/no-duplicate-case.js.

use std::borrow::Cow;

use bun_ast::{Case, Expr, S};

use crate::lint::context::Context;
use crate::lint::rule::{Rule, RuleCategory};

static RULE: Rule = Rule {
    name: "no-duplicate-case",
    category: RuleCategory::Correctness,
};

pub(crate) fn s_switch(context: &mut Context<'_, '_>, node: &S::Switch) {
    let mut tests: Vec<(Vec<u8>, &Case, &Expr)> = Vec::new();
    for case in node.cases.slice() {
        let Some(value) = &case.value else {
            continue;
        };
        // A test whose text does not read is not compared.
        if let Some(key) = context.case_test(value) {
            tests.push((key, case, value));
        }
    }
    if tests.len() < 2 {
        return;
    }
    // A stable sort: equal tests stay in the order they were written, and all but the first are duplicates.
    tests.sort_by(|a, b| a.0.cmp(&b.0));
    for pair in tests.windows(2) {
        let [(earlier, _, _), (key, case, value)] = pair else {
            continue;
        };
        if earlier == key {
            let start = context.case_start(case, value);
            context.report(&RULE, start, Cow::Borrowed(b"Duplicate case label."));
        }
    }
}
