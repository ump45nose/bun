//! What a rule handler is given: the text, the names, the reports, and the services that read the text again.

use std::borrow::Cow;

use bun_ast::{Case, Expr, Loc, Log, Ref, Source};
use bun_core::StackCheck;
use bun_js_parser::parse::parse_entry::ParsedOnly;

use super::rule::Rule;
use super::tokens::{self, Tokens};
use super::{Category, Code, Diagnostic, FileId};

/// The global names that a report can depend on.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Globals(u8);

impl Globals {
    pub(crate) const NONE: Globals = Globals(0);
    pub(crate) const NAN: Globals = Globals(1);
    pub(crate) const NUMBER: Globals = Globals(2);
    pub(crate) const UNDEFINED: Globals = Globals(4);

    pub(crate) const fn or(self, other: Globals) -> Globals {
        Globals(self.0 | other.0)
    }

    pub(crate) const fn is_none(self) -> bool {
        self.0 == 0
    }

    fn named(name: &[u8]) -> Globals {
        match name {
            b"NaN" => Globals::NAN,
            b"Number" => Globals::NUMBER,
            b"undefined" => Globals::UNDEFINED,
            _ => Globals::NONE,
        }
    }
}

pub(crate) struct Context<'p, 'a> {
    parsed: &'p ParsedOnly<'p, 'a>,
    source: &'a Source,
    arena: &'a bun_alloc::Arena,
    file: FileId,
    pub(crate) stack_check: StackCheck,
    reports: Vec<Diagnostic>,
    /// Reports that hold only when one of their names is not declared in the file.
    held: Vec<(Diagnostic, Globals)>,
    declared: Globals,
    cut: bool,
}

impl<'p, 'a> Context<'p, 'a> {
    pub(crate) fn new(
        parsed: &'p ParsedOnly<'p, 'a>,
        source: &'a Source,
        arena: &'a bun_alloc::Arena,
        file: FileId,
    ) -> Self {
        Context {
            parsed,
            source,
            arena,
            file,
            stack_check: StackCheck::init(),
            reports: Vec::new(),
            held: Vec::new(),
            declared: Globals::NONE,
            cut: false,
        }
    }

    #[inline]
    pub(crate) fn text(&self) -> &'a [u8] {
        self.source.contents()
    }

    /// The spelling of an identifier or of a binding. Empty for a reference that names nothing.
    pub(crate) fn name_of(&self, r#ref: Ref) -> &'a [u8] {
        if r#ref.is_valid() {
            self.parsed.name_of(r#ref)
        } else {
            b""
        }
    }

    /// A declaration of `ref` is somewhere in the file.
    pub(crate) fn declare(&mut self, r#ref: Ref) {
        self.declared = self.declared.or(Globals::named(self.name_of(r#ref)));
    }

    pub(crate) fn report(&mut self, rule: &'static Rule, at: Loc, text: Cow<'static, [u8]>) {
        self.report_if_global(rule, at, text, Globals::NONE);
    }

    /// Held until the walk ends; dropped when the file declares every name of `names`.
    pub(crate) fn report_if_global(
        &mut self,
        rule: &'static Rule,
        at: Loc,
        text: Cow<'static, [u8]>,
        names: Globals,
    ) {
        let (Some(category), Ok(start)) = (rule.category.default_level(), u32::try_from(at.start))
        else {
            return;
        };
        let diagnostic = Diagnostic {
            file: Some(self.file),
            start,
            length: self.token_len(start),
            category,
            code: Code::Name(rule.name),
            text,
        };
        if names.is_none() {
            self.reports.push(diagnostic);
        } else {
            self.held.push((diagnostic, names));
        }
    }

    /// The walk does not go deeper at `loc`. Said once per file, without reading the text: the stack is nearly used up.
    pub(crate) fn too_deep(&mut self, loc: Loc) {
        if !core::mem::replace(&mut self.cut, true) {
            self.reports.push(Diagnostic {
                file: Some(self.file),
                start: u32::try_from(loc.start).unwrap_or(0),
                length: 0,
                category: Category::Error,
                code: Code::INTERNAL_ERROR,
                text: Cow::Borrowed(b"The walk is nested too deeply."),
            });
        }
    }

    pub(crate) fn finish(self, diagnostics: &mut Vec<Diagnostic>) {
        let declared = self.declared;
        diagnostics.extend(self.reports);
        let held = self.held.into_iter();
        diagnostics.extend(
            held.filter(|(_, names)| names.0 & !declared.0 != 0)
                .map(|(diagnostic, _)| diagnostic),
        );
    }

    /// How many `)` between `own` and the token at `to` close a `(` that stands before `own`. `None`: not known.
    pub(crate) fn closes(&self, own: Loc, to: Loc, under: &[&Expr]) -> Option<u32> {
        let (own, to) = (u32::try_from(own.start).ok()?, u32::try_from(to.start).ok()?);
        if to.checked_sub(own)? > tokens::MAX_SCAN {
            return None;
        }
        let spans = tokens::spans_under(self.text(), under, self.stack_check)?;
        let mut log = Log::init();
        let mut tokens = Tokens::new(&mut log, self.source, self.arena, &spans, own);
        tokens::closes_between(&mut tokens, to)
    }

    /// Where ESLint starts the node whose first own token is at `own`, and how many `(` before `own` were not found.
    pub(crate) fn start_of(&self, own: Loc, to: Loc, under: &[&Expr]) -> (Loc, u32) {
        let Some(closes) = self.closes(own, to, under) else {
            return (own, 0);
        };
        match tokens::before_opens(self.text(), own, closes) {
            Some(start) => (start, 0),
            None => (own, closes),
        }
    }

    /// The tokens of the test of a `case` as one key: two tests are the same for ESLint when their keys are equal.
    pub(crate) fn case_test(&self, value: &Expr) -> Option<Vec<u8>> {
        let from = u32::try_from(value.loc.start).ok()?;
        let spans = tokens::spans_under(self.text(), &[value], self.stack_check)?;
        let mut log = Log::init();
        let mut tokens = Tokens::new(&mut log, self.source, self.arena, &spans, from);
        tokens::case_test_key(&mut tokens, self.text())
    }

    /// Where a clause starts: the keyword that the parser recorded, else the one the text before the test shows, else the test.
    pub(crate) fn case_start(&self, case: &Case, value: &Expr) -> Loc {
        if case.loc.start >= 0 {
            return case.loc;
        }
        tokens::case_before(self.text(), value.loc).unwrap_or(value.loc)
    }

    /// The offset after the `]` that closes the member whose index expression is `index`.
    pub(crate) fn close_bracket(&self, index: &Expr) -> Option<u32> {
        let from = u32::try_from(index.loc.start).ok()?;
        let spans = tokens::spans_under(self.text(), &[index], self.stack_check)?;
        let mut log = Log::init();
        let mut tokens = Tokens::new(&mut log, self.source, self.arena, &spans, from);
        tokens::close_bracket(&mut tokens)
    }

    /// The offset after the name, or the private name, that starts at `at`.
    pub(crate) fn name_end(&self, at: Loc) -> Option<u32> {
        let len = u32::try_from(self.source.range_of_identifier(at).len).ok()?;
        (len > 0).then_some(u32::try_from(at.start).ok()?.checked_add(len)?)
    }

    /// The length of the token that starts at `at`: the length of every report. 0 when the text there does not read.
    fn token_len(&self, at: u32) -> u32 {
        let mut log = Log::init();
        let mut tokens = Tokens::new(&mut log, self.source, self.arena, &[], at);
        match tokens.next() {
            Some(token) if token.start == at => token.end - token.start,
            _ => 0,
        }
    }
}
