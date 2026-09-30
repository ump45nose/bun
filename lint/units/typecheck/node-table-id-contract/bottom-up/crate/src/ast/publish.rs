// Gives a bound file its ids: the objects of the binder's open store move into the file and every id gets the base.
use crate::ast::file::{File, FlowList, FlowNode, IdAllocator, ListRecord, NodeRecord, Relocation, SymbolRecord, TableEntry, TableRecord, TextSpan, round_up_to_page};
use crate::ast::layout::SlotType;
use crate::ast::open::{Open, count};
use crate::tscore::deps::hash_bytes;
use crate::tscore::golang::Map;
use std::sync::atomic::AtomicU32;

#[derive(Debug, PartialEq, Eq)]
pub enum PublishError {
    AlreadyPublished,
    IdSpaceExhausted,
    StoreBusy,
}

// A table of this many entries or fewer is searched in order.
const LINEAR_TABLE: usize = 8;

// The texts of a file by their hash, so that a name that the file already has is not stored again.
struct TextIndex {
    by_hash: Map<u64, u32>,
}

impl TextIndex {
    fn new(file: &File) -> Self {
        let mut by_hash = Map::make();
        for id in 1..file.texts.len() as u32 {
            let _ = by_hash.set(hash_bytes(file.text(id)), id);
        }
        Self { by_hash }
    }
    fn intern(&mut self, file: &mut File, text: &[u8]) -> u32 {
        if text.is_empty() {
            return 0;
        }
        let hash = hash_bytes(text);
        let known = self.by_hash.get(&hash);
        if known != 0 && file.text(known) == text {
            return known;
        }
        let start = file.text_bytes.len() as u32;
        file.text_bytes.extend_from_slice(text);
        file.texts.push(TextSpan { start, len: text.len() as u32 });
        let id = (file.texts.len() - 1) as u32;
        let _ = self.by_hash.set(hash, id);
        id
    }
}

impl File {
    // Ends the binding of `self`: `open` is the store of its binder. The result is immutable and can be shared.
    pub fn publish(mut self, open: &Open<'_>, ids: &IdAllocator) -> Result<File, PublishError> {
        if self.is_published() {
            return Err(PublishError::AlreadyPublished);
        }
        let (Ok(nodes), Ok(lists), Ok(texts), Ok(symbols), Ok(tables), Ok(flow_nodes), Ok(flow_lists), Ok(symbol_ids)) = (
            open.nodes.try_borrow(),
            open.lists.try_borrow(),
            open.texts.try_borrow(),
            open.symbols.try_borrow(),
            open.tables.try_borrow(),
            open.flow_nodes.try_borrow(),
            open.flow_lists.try_borrow(),
            open.open_symbol_ids.try_borrow(),
        ) else {
            return Err(PublishError::StoreBusy);
        };
        let syntax_nodes = self.node_count();
        let syntax_lists = self.list_count();
        let needed = (syntax_nodes + count(&open.nodes))
            .max(syntax_lists + count(&open.lists))
            .max(count(&open.symbols))
            .max(count(&open.tables))
            .max(count(&open.flow_nodes))
            .max(count(&open.flow_lists));
        let span = needed.checked_add(1).and_then(round_up_to_page).ok_or(PublishError::IdSpaceExhausted)?;
        let base = ids.alloc(span).ok_or(PublishError::IdSpaceExhausted)?;
        let map = Relocation { base, syntax_nodes, syntax_lists };

        self.relocate_syntax(&map);
        for record in &self.records {
            let mask = record.def.info().late;
            let mut rank = 0usize;
            for bit_index in 0..8u8 {
                let bit = 1u8 << bit_index;
                if mask & bit == 0 {
                    continue;
                }
                if let Some(cell) = self.late.get_mut(record.late as usize + rank) {
                    *cell.get_mut() = map.late(bit, *cell.get_mut());
                }
                rank += 1;
            }
        }

        let mut text_index = TextIndex::new(&self);
        // The nodes that the binder made: the data of the flow nodes of a switch clause and of a reduced label.
        for node in nodes.iter().skip(1) {
            let info = node.def.info();
            let data = self.slots.len() as u32;
            for (index, slot) in info.slots.iter().enumerate() {
                let value = node.slots.get(index).copied().unwrap_or(0);
                let moved = match slot.ty {
                    SlotType::Text => text_index.intern(&mut self, texts.get(value as usize).copied().unwrap_or(b"")),
                    ty => map.slot(ty, value),
                };
                self.slots.push(moved);
            }
            let late = self.late.len() as u32;
            for bit_index in 0..8u8 {
                let bit = 1u8 << bit_index;
                if info.late & bit != 0 {
                    self.late.push(AtomicU32::new(map.late(bit, node.late.get(usize::from(bit_index)).copied().unwrap_or(0))));
                }
            }
            self.records.push(NodeRecord { loc: node.loc, parent: map.node(node.parent), data, late, kind: node.kind, def: node.def });
            self.flags.push(AtomicU32::new(node.flags.0));
        }
        for list in lists.iter().skip(1) {
            let start = self.list_items.len() as u32;
            self.list_items.extend(list.nodes.iter().map(|node| map.node(node)));
            self.lists.push(ListRecord { loc: list.loc, start, len: list.nodes.len() as u32, modifier_flags: list.modifier_flags });
        }

        self.symbols.push(SymbolRecord::default());
        for (index, symbol) in symbols.iter().enumerate().skip(1) {
            let declarations_start = self.declarations.len() as u32;
            self.declarations.extend(symbol.declarations.iter().map(|node| map.node(node)));
            let name = text_index.intern(&mut self, symbol.name);
            self.symbols.push(SymbolRecord {
                flags: symbol.flags,
                name,
                declarations_start,
                declarations_len: symbol.declarations.len() as u32,
                value_declaration: map.node(symbol.value_declaration),
                members: map.table(symbol.members),
                exports: map.table(symbol.exports),
                parent: map.symbol(symbol.parent),
                export_symbol: map.symbol(symbol.export_symbol),
                lazy_id: symbol_ids.get(index).copied().unwrap_or(0) as u32,
            });
        }
        self.tables.push(TableRecord::default());
        for table in tables.iter().skip(1) {
            let entries_start = self.table_entries.len() as u32;
            let len = table.len() as usize;
            for position in 0..len {
                if let Some((name, symbol)) = table.entry_at(position) {
                    let name = text_index.intern(&mut self, name);
                    self.table_entries.push(TableEntry { name, symbol: map.symbol(symbol) });
                }
            }
            let mut record = TableRecord { entries_start, len: len as u32, index_start: self.table_index.len() as u32, index_len: 0 };
            if len > LINEAR_TABLE {
                let size = (len * 2).next_power_of_two();
                record.index_len = size as u32;
                let mut index = vec![0u32; size];
                for position in 0..len {
                    let Some(entry) = self.table_entries.get(entries_start as usize + position) else {
                        continue;
                    };
                    let mut at = hash_bytes(self.text(entry.name)) as usize & (size - 1);
                    while index.get(at).is_some_and(|slot| *slot != 0) {
                        at = (at + 1) & (size - 1);
                    }
                    if let Some(slot) = index.get_mut(at) {
                        *slot = position as u32 + 1;
                    }
                }
                self.table_index.extend_from_slice(&index);
            }
            self.tables.push(record);
        }
        self.flow_nodes.push(FlowNode::default());
        for flow in flow_nodes.iter().skip(1) {
            self.flow_nodes.push(FlowNode {
                flags: flow.flags,
                node: map.node(flow.node),
                antecedent: map.flow_node(flow.antecedent),
                antecedents: map.flow_list(flow.antecedents),
            });
        }
        self.flow_lists.push(FlowList::default());
        for list in flow_lists.iter().skip(1) {
            self.flow_lists.push(FlowList { flow: map.flow_node(list.flow), next: map.flow_list(list.next) });
        }

        self.source_file.symbol_count = count(&open.symbols);
        self.base = base;
        self.span = span;
        self.serial = open.serial;
        self.shrink();
        Ok(self)
    }

    fn shrink(&mut self) {
        self.records.shrink_to_fit();
        self.slots.shrink_to_fit();
        self.lists.shrink_to_fit();
        self.list_items.shrink_to_fit();
        self.texts.shrink_to_fit();
        self.text_bytes.shrink_to_fit();
        self.jsdoc.shrink_to_fit();
        self.flags.shrink_to_fit();
        self.late.shrink_to_fit();
        self.symbols.shrink_to_fit();
        self.declarations.shrink_to_fit();
        self.tables.shrink_to_fit();
        self.table_entries.shrink_to_fit();
        self.table_index.shrink_to_fit();
        self.flow_nodes.shrink_to_fit();
        self.flow_lists.shrink_to_fit();
    }
}

