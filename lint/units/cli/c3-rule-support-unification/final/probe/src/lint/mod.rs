//! Stand-in for `src/lint/lib.rs`: the entry of the rules, and the diagnostic types that the output layer of the crate owns.

mod context;
mod linter;
mod rule;
mod rules;
mod tokens;

use std::borrow::Cow;

use bun_js_parser::parse::parse_entry::ParsedOnly;

/// Stand-in for `diagnostic::Category`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Category {
    Error,
}

/// Stand-in for `diagnostic::Code`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Code {
    Name(&'static str),
}

impl Code {
    pub(crate) const INTERNAL_ERROR: Code = Code::Name("internal-error");
}

/// Stand-in for `source_file::FileId`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileId(pub(crate) u32);

/// Stand-in for `diagnostic::Diagnostic`: the fields that a rule fills.
pub(crate) struct Diagnostic {
    pub(crate) file: Option<FileId>,
    pub(crate) start: u32,
    pub(crate) length: u32,
    pub(crate) category: Category,
    pub(crate) code: Code,
    pub(crate) text: Cow<'static, [u8]>,
}

/// Runs every rule over the statements of one file as they were written, in one walk. What it adds is not sorted.
pub(crate) fn lint<'a>(
    parsed: &ParsedOnly<'_, 'a>,
    source: &'a bun_ast::Source,
    arena: &'a bun_alloc::Arena,
    file: FileId,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let context = context::Context::new(parsed, source, arena, file);
    linter::run(context, parsed.stmts, diagnostics);
}
