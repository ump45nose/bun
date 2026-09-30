// The table of one source file. `File::publish` gives it its ids; after that nothing writes to it.
use crate::ast::ast_generated::Def;
use crate::ast::flags_generated::{FlowFlags, ModifierFlags, NodeFlags, SymbolFlags};
use crate::ast::kind_generated::Kind;
use crate::ast::layout::{SlotType, late_rank};
use crate::tscore::deps::hash_bytes;
use crate::tscore::ids::{FlowListId, FlowNodeId, NodeId, NodeListId, OPEN_BIT, PAGE_SIZE, SymbolId, SymbolTableId};
use crate::tscore::text::TextRange;
use std::sync::atomic::{AtomicU32, Ordering};

#[derive(Clone, Copy, Default, Debug)]
pub struct NodeRecord {
    pub loc: TextRange,
    pub parent: NodeId,
    // The first slot of the node.
    pub data: u32,
    // The first late field of the node.
    pub late: u32,
    pub kind: Kind,
    pub def: Def,
}

const _: () = assert!(std::mem::size_of::<NodeRecord>() == 24);

#[derive(Clone, Copy, Default, Debug)]
pub struct ListRecord {
    pub loc: TextRange,
    pub start: u32,
    pub len: u32,
    // ModifierList.ModifierFlags; 0 in a NodeList.
    pub modifier_flags: ModifierFlags,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct TextSpan {
    pub start: u32,
    pub len: u32,
}

// ast.Symbol of a published file. The name is a text of the file, the declarations a run of `declarations`.
#[derive(Clone, Copy, Default, Debug)]
pub struct SymbolRecord {
    pub flags: SymbolFlags,
    pub name: u32,
    pub declarations_start: u32,
    pub declarations_len: u32,
    pub value_declaration: NodeId,
    pub members: SymbolTableId,
    pub exports: SymbolTableId,
    pub parent: SymbolId,
    pub export_symbol: SymbolId,
    // The count of the binder's ast.GetSymbolId calls when it asked for the id of this symbol, else 0.
    pub lazy_id: u32,
}

// ast.FlowNode. The ids are plain data, so a published file and an open store keep the same struct.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct FlowNode {
    pub flags: FlowFlags,
    pub node: NodeId,
    pub antecedent: FlowNodeId,
    pub antecedents: FlowListId,
}

// ast.FlowList
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct FlowList {
    pub flow: FlowNodeId,
    pub next: FlowListId,
}

// ast.SymbolTable of a published file: entries in insertion order and, above eight entries, a hash index.
#[derive(Clone, Copy, Default, Debug)]
pub struct TableRecord {
    pub entries_start: u32,
    pub len: u32,
    pub index_start: u32,
    // A power of two, or 0 for a table that is searched in order.
    pub index_len: u32,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct TableEntry {
    pub name: u32,
    pub symbol: SymbolId,
}

// What SourceFile keeps beside the tree. The prototype carries the part that the node table needs.
#[derive(Default, Debug)]
pub struct SourceFileData {
    pub file_name: Vec<u8>,
    pub script_kind: u8,
    pub language_variant: u8,
    pub is_declaration_file: bool,
    pub root: NodeId,
    pub external_module_indicator: NodeId,
    pub common_js_module_indicator: NodeId,
    pub node_count: u32,
    pub text_count: u32,
    pub identifier_count: u32,
    pub symbol_count: u32,
    pub text_len: u32,
}

#[derive(Default)]
pub struct File {
    // 0 until the file is published. The ids of the file are base + 1 .. base + span.
    pub(crate) base: u32,
    pub(crate) span: u32,
    // Unique in the process, part of the lazy symbol ids that the binder hands out.
    pub(crate) serial: u32,
    pub(crate) records: Vec<NodeRecord>,
    pub(crate) slots: Vec<u32>,
    pub(crate) lists: Vec<ListRecord>,
    pub(crate) list_items: Vec<NodeId>,
    pub(crate) texts: Vec<TextSpan>,
    // The source text, then the texts that are not in it.
    pub(crate) text_bytes: Vec<u8>,
    // Hosts in ascending order with the list of their JSDoc nodes.
    pub(crate) jsdoc: Vec<(NodeId, NodeListId)>,
    // Written by the binder through a shared reference, then never again.
    pub(crate) flags: Vec<AtomicU32>,
    pub(crate) late: Vec<AtomicU32>,
    pub(crate) symbols: Vec<SymbolRecord>,
    pub(crate) declarations: Vec<NodeId>,
    pub(crate) tables: Vec<TableRecord>,
    pub(crate) table_entries: Vec<TableEntry>,
    pub(crate) table_index: Vec<u32>,
    pub(crate) flow_nodes: Vec<FlowNode>,
    pub(crate) flow_lists: Vec<FlowList>,
    pub source_file: SourceFileData,
}

// A file is shared between the programs and the checkers of a process.
const _: () = {
    const fn assert_sync<T: Sync + Send>() {}
    assert_sync::<File>();
};

// Hands out the id ranges and the serial numbers of the files of a process.
pub struct IdAllocator {
    next: AtomicU32,
    serial: AtomicU32,
}

impl Default for IdAllocator {
    fn default() -> Self {
        Self::new()
    }
}

impl IdAllocator {
    pub const fn new() -> Self {
        Self {
            next: AtomicU32::new(PAGE_SIZE),
            serial: AtomicU32::new(1),
        }
    }
    // A base for `span` ids, or None when the id space below the open bit is used up.
    pub fn alloc(&self, span: u32) -> Option<u32> {
        self.next
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| {
                next.checked_add(span).filter(|end| *end <= OPEN_BIT)
            })
            .ok()
    }
    pub fn next_serial(&self) -> u32 {
        self.serial.fetch_add(1, Ordering::Relaxed)
    }
    pub fn used(&self) -> u32 {
        self.next.load(Ordering::Relaxed)
    }
}

pub(crate) fn round_up_to_page(count: u32) -> Option<u32> {
    count.checked_add(PAGE_SIZE - 1).map(|n| n & !(PAGE_SIZE - 1))
}

impl File {
    pub fn base(&self) -> u32 {
        self.base
    }
    pub fn span(&self) -> u32 {
        self.span
    }
    pub fn serial(&self) -> u32 {
        self.serial
    }
    pub fn is_published(&self) -> bool {
        self.span != 0
    }
    // The nodes of the file, the nil record not counted.
    pub fn node_count(&self) -> u32 {
        self.records.len().saturating_sub(1) as u32
    }
    pub fn list_count(&self) -> u32 {
        self.lists.len().saturating_sub(1) as u32
    }
    pub fn symbol_count(&self) -> u32 {
        self.symbols.len().saturating_sub(1) as u32
    }
    pub fn table_count(&self) -> u32 {
        self.tables.len().saturating_sub(1) as u32
    }
    pub fn flow_node_count(&self) -> u32 {
        self.flow_nodes.len().saturating_sub(1) as u32
    }
    pub fn slot_count(&self) -> u32 {
        self.slots.len() as u32
    }
    pub fn late_count(&self) -> u32 {
        self.late.len() as u32
    }
    pub fn source_text(&self) -> &[u8] {
        self.text_bytes.get(..self.source_file.text_len as usize).unwrap_or(&[])
    }
    // The bytes that the file keeps on the heap.
    pub fn heap_bytes(&self) -> usize {
        use std::mem::size_of;
        self.records.capacity() * size_of::<NodeRecord>()
            + self.slots.capacity() * 4
            + self.lists.capacity() * size_of::<ListRecord>()
            + self.list_items.capacity() * 4
            + self.texts.capacity() * size_of::<TextSpan>()
            + self.text_bytes.capacity()
            + self.jsdoc.capacity() * 8
            + self.flags.capacity() * 4
            + self.late.capacity() * 4
            + self.symbols.capacity() * size_of::<SymbolRecord>()
            + self.declarations.capacity() * 4
            + self.tables.capacity() * size_of::<TableRecord>()
            + self.table_entries.capacity() * size_of::<TableEntry>()
            + self.table_index.capacity() * 4
            + self.flow_nodes.capacity() * size_of::<FlowNode>()
            + self.flow_lists.capacity() * size_of::<FlowList>()
            + self.source_file.file_name.capacity()
    }

    #[inline]
    pub(crate) fn record(&self, local: usize) -> Option<&NodeRecord> {
        self.records.get(local)
    }
    #[inline]
    pub(crate) fn node_slots(&self, record: &NodeRecord) -> &[u32] {
        let start = record.data as usize;
        self.slots.get(start..start + record.def.info().slots.len()).unwrap_or(&[])
    }
    #[inline]
    pub(crate) fn node_flags(&self, local: usize) -> NodeFlags {
        match self.flags.get(local) {
            Some(cell) => NodeFlags(cell.load(Ordering::Relaxed)),
            None => NodeFlags::NONE,
        }
    }
    #[inline]
    pub(crate) fn late_cell(&self, record: &NodeRecord, bit: u8) -> Option<&AtomicU32> {
        let mask = record.def.info().late;
        if mask & bit == 0 {
            return None;
        }
        self.late.get(record.late as usize + late_rank(mask, bit))
    }
    #[inline]
    pub(crate) fn list(&self, local: usize) -> Option<&ListRecord> {
        self.lists.get(local)
    }
    #[inline]
    pub(crate) fn list_nodes(&self, list: &ListRecord) -> &[NodeId] {
        let start = list.start as usize;
        self.list_items.get(start..start + list.len as usize).unwrap_or(&[])
    }
    #[inline]
    pub(crate) fn text(&self, id: u32) -> &[u8] {
        match self.texts.get(id as usize) {
            Some(span) => {
                let start = span.start as usize;
                self.text_bytes.get(start..start + span.len as usize).unwrap_or(&[])
            }
            None => &[],
        }
    }
    pub(crate) fn jsdoc_of(&self, host: NodeId) -> NodeListId {
        match self.jsdoc.binary_search_by(|entry| entry.0.cmp(&host)) {
            Ok(at) => self.jsdoc.get(at).map_or(NodeListId::NIL, |entry| entry.1),
            Err(_) => NodeListId::NIL,
        }
    }
    pub(crate) fn symbol_declarations(&self, symbol: &SymbolRecord) -> &[NodeId] {
        let start = symbol.declarations_start as usize;
        self.declarations.get(start..start + symbol.declarations_len as usize).unwrap_or(&[])
    }
    pub(crate) fn table_entries(&self, table: &TableRecord) -> &[TableEntry] {
        let start = table.entries_start as usize;
        self.table_entries.get(start..start + table.len as usize).unwrap_or(&[])
    }
    pub(crate) fn table_lookup(&self, table: &TableRecord, name: &[u8]) -> SymbolId {
        let entries = self.table_entries(table);
        if table.index_len == 0 {
            return entries.iter().find(|entry| self.text(entry.name) == name).map_or(SymbolId::NIL, |entry| entry.symbol);
        }
        let start = table.index_start as usize;
        let Some(index) = self.table_index.get(start..start + table.index_len as usize) else {
            return SymbolId::NIL;
        };
        let mask = index.len() - 1;
        let mut at = hash_bytes(name) as usize & mask;
        for _ in 0..index.len() {
            let Some(&slot) = index.get(at) else { break };
            if slot == 0 {
                break;
            }
            if let Some(entry) = entries.get(slot as usize - 1) {
                if self.text(entry.name) == name {
                    return entry.symbol;
                }
            }
            at = (at + 1) & mask;
        }
        SymbolId::NIL
    }

    // Rewrites every id that the syntax part of the file holds. Used once, when the file gets its base.
    pub(crate) fn relocate_syntax(&mut self, map: &Relocation) {
        for record in &mut self.records {
            record.parent = map.node(record.parent);
        }
        let records = &self.records;
        let slots = &mut self.slots;
        for record in records {
            let info = record.def.info();
            let start = record.data as usize;
            let Some(values) = slots.get_mut(start..start + info.slots.len()) else {
                continue;
            };
            for (value, slot) in values.iter_mut().zip(info.slots) {
                *value = map.slot(slot.ty, *value);
            }
        }
        for item in &mut self.list_items {
            *item = map.node(*item);
        }
        for entry in &mut self.jsdoc {
            *entry = (map.node(entry.0), map.list(entry.1));
        }
        let source_file = &mut self.source_file;
        source_file.root = map.node(source_file.root);
        source_file.external_module_indicator = map.node(source_file.external_module_indicator);
        source_file.common_js_module_indicator = map.node(source_file.common_js_module_indicator);
    }
}

// Local ids to ids of the process: base is added, an id of the binder's open store lands behind the ids of the parse.
pub struct Relocation {
    pub base: u32,
    pub syntax_nodes: u32,
    pub syntax_lists: u32,
}

impl Relocation {
    #[inline]
    fn shift(&self, id: u32, before: u32) -> u32 {
        if id == 0 {
            0
        } else if id & OPEN_BIT != 0 {
            self.base.wrapping_add(before).wrapping_add(id & !OPEN_BIT)
        } else {
            self.base.wrapping_add(id)
        }
    }
    #[inline]
    pub fn node(&self, id: NodeId) -> NodeId {
        NodeId(self.shift(id.0, self.syntax_nodes))
    }
    #[inline]
    pub fn list(&self, id: NodeListId) -> NodeListId {
        NodeListId(self.shift(id.0, self.syntax_lists))
    }
    #[inline]
    pub fn symbol(&self, id: SymbolId) -> SymbolId {
        SymbolId(self.shift(id.0, 0))
    }
    #[inline]
    pub fn table(&self, id: SymbolTableId) -> SymbolTableId {
        SymbolTableId(self.shift(id.0, 0))
    }
    #[inline]
    pub fn flow_node(&self, id: FlowNodeId) -> FlowNodeId {
        FlowNodeId(self.shift(id.0, 0))
    }
    #[inline]
    pub fn flow_list(&self, id: FlowListId) -> FlowListId {
        FlowListId(self.shift(id.0, 0))
    }
    #[inline]
    pub fn slot(&self, ty: SlotType, value: u32) -> u32 {
        match ty {
            SlotType::Node => self.shift(value, self.syntax_nodes),
            SlotType::NodeList | SlotType::ModifierList | SlotType::RawNodeList => self.shift(value, self.syntax_lists),
            SlotType::FlowNode | SlotType::FlowList => self.shift(value, 0),
            SlotType::Text | SlotType::Bool | SlotType::Kind | SlotType::TokenFlags | SlotType::Int | SlotType::TypeId => value,
        }
    }
    // A late field by the bit of its name.
    #[inline]
    pub fn late(&self, bit: u8, value: u32) -> u32 {
        if bit == crate::ast::layout::LATE_NEXT_CONTAINER {
            self.shift(value, self.syntax_nodes)
        } else {
            self.shift(value, 0)
        }
    }
}
