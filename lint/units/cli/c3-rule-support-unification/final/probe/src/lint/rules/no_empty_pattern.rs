//! Ported from ESLint lib/rules/no-empty-pattern.js, with its default: an empty object pattern as a parameter is reported.

use std::borrow::Cow;

use bun_ast::{B, E, Loc};

use crate::lint::context::Context;
use crate::lint::rule::{Rule, RuleCategory};

static RULE: Rule = Rule {
    name: "no-empty-pattern",
    category: RuleCategory::Correctness,
};

const ARRAY: &[u8] = b"Unexpected empty array pattern.";
const OBJECT: &[u8] = b"Unexpected empty object pattern.";

pub(crate) fn b_array(context: &mut Context<'_, '_>, node: &B::Array, loc: Loc) {
    if node.items.slice().is_empty() {
        context.report(&RULE, loc, Cow::Borrowed(ARRAY));
    }
}

pub(crate) fn b_object(context: &mut Context<'_, '_>, node: &B::Object, loc: Loc) {
    if node.properties.slice().is_empty() {
        context.report(&RULE, loc, Cow::Borrowed(OBJECT));
    }
}

/// `node` is the target of an assignment.
pub(crate) fn e_array(context: &mut Context<'_, '_>, node: &E::Array, loc: Loc) {
    if node.items.as_slice().is_empty() {
        context.report(&RULE, loc, Cow::Borrowed(ARRAY));
    }
}

/// `node` is the target of an assignment.
pub(crate) fn e_object(context: &mut Context<'_, '_>, node: &E::Object, loc: Loc) {
    if node.properties.as_slice().is_empty() {
        context.report(&RULE, loc, Cow::Borrowed(OBJECT));
    }
}
