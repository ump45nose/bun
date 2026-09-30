//! Ported from ESLint lib/rules/no-sparse-arrays.js.

use std::borrow::Cow;

use bun_ast::{E, ExprData};

use crate::lint::context::Context;
use crate::lint::rule::{Rule, RuleCategory};

static RULE: Rule = Rule {
    name: "no-sparse-arrays",
    category: RuleCategory::Correctness,
};

/// `node` is an array literal, not a pattern. The node of a hole is at the comma that follows the hole.
pub(crate) fn e_array(context: &mut Context<'_, '_>, node: &E::Array) {
    for item in node.items.as_slice() {
        if matches!(item.data, ExprData::EMissing(_)) {
            context.report(
                &RULE,
                item.loc,
                Cow::Borrowed(b"Unexpected comma in middle of array."),
            );
        }
    }
}
