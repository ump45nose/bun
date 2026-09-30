// Prints a tree in the text form of the Go probe that dumped the reference's own trees
// (ts-dump-and-test-importer/groundtruth/dumpast/main.go), so that a digest of the lines can be compared.
use crate::ast::ast_generated::{Def, SlotType, layout};
use crate::ast::context::Ast;
use crate::ast::flags_generated::NodeFlags;
use crate::ast::kind_generated::Kind;
use crate::ids::{ModifierListId, NodeId, NodeListId};
use std::io::Write;

pub struct Dump<'a, 's> {
    a: Ast<'a>,
    no_jsdoc: bool,
    line: Vec<u8>,
    sink: &'s mut dyn FnMut(&[u8]),
    pub nodes: u32,
}

const MAX_DEPTH: usize = 4000;

// strconv.QuoteToASCII
pub fn quote_to_ascii(text: &[u8], out: &mut Vec<u8>) {
    out.push(b'"');
    let mut rest = text;
    while let Some(&first) = rest.first() {
        let (rune, width) = decode_rune(rest);
        rest = rest.get(width..).unwrap_or(&[]);
        if width == 1 && rune == 0xFFFD {
            let _ = write!(out, "\\x{first:02x}");
            continue;
        }
        match rune {
            0x22 | 0x5C => {
                out.push(b'\\');
                out.push(rune as u8);
            }
            0x20..=0x7E => out.push(rune as u8),
            0x07 => out.extend_from_slice(b"\\a"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0C => out.extend_from_slice(b"\\f"),
            0x0A => out.extend_from_slice(b"\\n"),
            0x0D => out.extend_from_slice(b"\\r"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x0B => out.extend_from_slice(b"\\v"),
            r if r < 0x20 || r == 0x7F => {
                let _ = write!(out, "\\x{r:02x}");
            }
            r if r < 0x10000 => {
                let _ = write!(out, "\\u{r:04x}");
            }
            r => {
                let _ = write!(out, "\\U{r:08x}");
            }
        }
    }
    out.push(b'"');
}

// utf8.DecodeRune: (0xFFFD, 1) for a byte that starts no valid sequence.
fn decode_rune(bytes: &[u8]) -> (u32, usize) {
    let Some(&first) = bytes.first() else {
        return (0xFFFD, 0);
    };
    if first < 0x80 {
        return (u32::from(first), 1);
    }
    let width = match first {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return (0xFFFD, 1),
    };
    match bytes.get(..width).map(std::str::from_utf8) {
        Some(Ok(text)) => match text.chars().next() {
            Some(ch) => (u32::from(ch), width),
            None => (0xFFFD, 1),
        },
        _ => (0xFFFD, 1),
    }
}

impl<'a, 's> Dump<'a, 's> {
    pub fn new(a: Ast<'a>, no_jsdoc: bool, sink: &'s mut dyn FnMut(&[u8])) -> Self {
        Self {
            a,
            no_jsdoc,
            line: Vec::new(),
            sink,
            nodes: 0,
        }
    }
    fn flush(&mut self) {
        (self.sink)(&self.line);
        self.line.clear();
    }
    fn pad(&mut self, indent: usize) {
        self.line.resize(self.line.len() + indent, b' ');
    }
    fn list(&mut self, label: &str, raw: bool, list: NodeListId, parent: NodeId, indent: usize) {
        let a = self.a;
        let nodes = a.list_nodes(list);
        let loc = a.list_loc(list);
        self.pad(indent);
        let _ = write!(
            self.line,
            ".{}{}: list [{},{}) n={}",
            label,
            if raw { "(raw)" } else { "" },
            loc.pos(),
            loc.end(),
            nodes.len()
        );
        self.flush();
        for child in nodes.iter() {
            self.node("-", child, parent, indent + 2);
        }
    }
    pub fn node(&mut self, label: &str, node: NodeId, parent: NodeId, indent: usize) {
        let a = self.a;
        self.pad(indent);
        if node.is_nil() {
            let _ = write!(self.line, "{label} <nil>");
            self.flush();
            return;
        }
        if indent > MAX_DEPTH {
            let _ = write!(self.line, "{label} <too deep>");
            self.flush();
            return;
        }
        self.nodes += 1;
        let kind = node.kind(a);
        let loc = node.loc(a);
        let _ = write!(
            self.line,
            "{} {} [{},{}) f={:#x}",
            label,
            kind.string(),
            loc.pos(),
            loc.end(),
            node.flags(a).bits()
        );
        let actual = node.parent(a);
        if actual != parent {
            if actual.is_nil() {
                self.line.extend_from_slice(b" parent=nil");
            } else {
                let ploc = actual.loc(a);
                let _ = write!(
                    self.line,
                    " parent={}[{},{})",
                    actual.kind(a).string(),
                    ploc.pos(),
                    ploc.end()
                );
            }
        }
        let (def, slots) = a.slots_any(node);
        let mut fields: Vec<(&'static str, SlotType, u32)> = Vec::new();
        if kind != Kind::SourceFile {
            for (field, value) in layout(def).slots.iter().zip(slots.iter()) {
                match field.ty {
                    SlotType::Node
                    | SlotType::NodeList
                    | SlotType::ModifierList
                    | SlotType::RawNodeList
                    | SlotType::Kind
                    | SlotType::TokenFlags
                    | SlotType::Text
                    | SlotType::Bool => fields.push((field.name, field.ty, *value)),
                    _ => {}
                }
            }
        }
        fields.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
        for &(name, ty, value) in &fields {
            match ty {
                SlotType::Kind => {
                    let _ = write!(self.line, " {}={}", name, Kind::from_u16(value as u16).string());
                }
                SlotType::TokenFlags => {
                    let _ = write!(self.line, " {name}={value:#x}");
                }
                SlotType::Text => {
                    let _ = write!(self.line, " {name}=");
                    quote_to_ascii(a.node_text(node, value), &mut self.line);
                }
                SlotType::Bool if value != 0 => {
                    let _ = write!(self.line, " {name}");
                }
                _ => {}
            }
        }
        self.flush();
        if def == Def::SourceFile {
            let file = node.as_source_file(a);
            self.list("Statements", false, file.statements, node, indent + 2);
            self.node(".EndOfFileToken:", file.end_of_file_token, node, indent + 2);
        }
        for &(name, ty, value) in &fields {
            if value == 0 {
                continue;
            }
            match ty {
                SlotType::Node => {
                    let mut label = String::with_capacity(name.len() + 2);
                    label.push('.');
                    label.push_str(name);
                    label.push(':');
                    self.node(&label, NodeId(value), node, indent + 2);
                }
                SlotType::NodeList => self.list(name, false, NodeListId(value), node, indent + 2),
                SlotType::RawNodeList => self.list(name, true, NodeListId(value), node, indent + 2),
                SlotType::ModifierList => {
                    self.pad(indent + 2);
                    let _ = write!(
                        self.line,
                        ".{}.flags={:#x}",
                        name,
                        a.list_modifier_flags(ModifierListId(value)).bits()
                    );
                    self.flush();
                    self.list(name, false, NodeListId(value), node, indent + 2);
                }
                _ => {}
            }
        }
        if !self.no_jsdoc && node.flags(a).intersects(NodeFlags::HAS_JSDOC) {
            for doc in node.jsdoc(a).iter() {
                self.node(".jsdoc:", doc, node, indent + 2);
            }
        }
    }
}

// FNV-1a 64 over the lines, each followed by a line feed, as the golden digests are made.
pub fn tree_digest(a: Ast<'_>, root: NodeId, no_jsdoc: bool) -> (u64, u32) {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut sink = |line: &[u8]| {
        for &b in line.iter().chain(std::iter::once(&b'\n')) {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    let mut dump = Dump::new(a, no_jsdoc, &mut sink);
    dump.node("root", root, NodeId::NIL, 0);
    let nodes = dump.nodes;
    (hash, nodes)
}
