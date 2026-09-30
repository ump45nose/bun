//! One module per rule, named as ESLint names the rule, and what they share.

pub(crate) mod ast_utils;
pub(crate) mod no_compare_neg_zero;
pub(crate) mod no_debugger;
pub(crate) mod no_dupe_class_members;
pub(crate) mod no_dupe_keys;
pub(crate) mod no_duplicate_case;
pub(crate) mod no_empty_pattern;
pub(crate) mod no_self_assign;
pub(crate) mod no_sparse_arrays;
pub(crate) mod no_unsafe_negation;
pub(crate) mod use_isnan;
pub(crate) mod valid_typeof;

use std::borrow::Cow;

use bun_ast::OpCode;

/// `<`, `<=`, `>`, `>=`, `==`, `!=`, `===`, `!==`.
pub(crate) fn is_comparison(op: OpCode) -> bool {
    is_equality(op)
        || matches!(
            op,
            OpCode::BinLt | OpCode::BinLe | OpCode::BinGt | OpCode::BinGe
        )
}

/// `==`, `!=`, `===`, `!==`.
pub(crate) fn is_equality(op: OpCode) -> bool {
    matches!(
        op,
        OpCode::BinLooseEq | OpCode::BinLooseNe | OpCode::BinStrictEq | OpCode::BinStrictNe
    )
}

/// The text of a report: `parts` one after the other.
pub(crate) fn text(parts: &[&[u8]]) -> Cow<'static, [u8]> {
    Cow::Owned(parts.concat())
}
