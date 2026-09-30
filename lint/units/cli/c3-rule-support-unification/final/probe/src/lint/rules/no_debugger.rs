//! Ported from ESLint lib/rules/no-debugger.js.

use std::borrow::Cow;

use bun_ast::Loc;

use crate::lint::context::Context;
use crate::lint::rule::{Rule, RuleCategory};

static RULE: Rule = Rule {
    name: "no-debugger",
    category: RuleCategory::Correctness,
};

pub(crate) fn s_debugger(context: &mut Context<'_, '_>, loc: Loc) {
    context.report(
        &RULE,
        loc,
        Cow::Borrowed(b"Unexpected 'debugger' statement."),
    );
}
