//! ESLint's `getStaticPropertyName` and `getStaticStringValue` (lib/rules/utils/ast-utils.js) on Bun's nodes.

use bun_ast::{E, Expr, ExprData};

/// The name of a property as the program would see it, in UTF-8.
pub(crate) enum Name<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
}

impl Name<'_> {
    #[inline]
    pub(crate) fn bytes(&self) -> &[u8] {
        match self {
            Name::Borrowed(bytes) => bytes,
            Name::Owned(bytes) => bytes,
        }
    }
}

/// The name that a key or an index gives, when that is known without running the program.
pub(crate) fn of_key(key: &Expr) -> Option<Name<'_>> {
    match &key.data {
        ExprData::EString(string) => of_string(string),
        ExprData::ENumber(number) => {
            let mut buffer = [0u8; 124];
            Some(Name::Owned(bun_core::fmt::FormatDouble::dtoa(&mut buffer, number.value()).to_vec()))
        }
        ExprData::EBigInt(big) => of_big_int(big.value.slice()),
        ExprData::EBoolean(boolean) => Some(Name::Borrowed(if boolean.value { b"true" } else { b"false" })),
        ExprData::ENull(_) => Some(Name::Borrowed(b"null")),
        ExprData::ERegExp(reg_exp) => Some(of_reg_exp(reg_exp)),
        _ => None,
    }
}

/// The name of the property that a member expression reads.
pub(crate) fn of_member(member: &Expr) -> Option<Name<'_>> {
    match &member.data {
        ExprData::EDot(dot) => Some(Name::Borrowed(dot.name.slice())),
        ExprData::EIndex(index) => of_key(&index.index),
        _ => None,
    }
}

fn of_string(string: &E::EString) -> Option<Name<'_>> {
    if string.next.is_some() {
        return None;
    }
    if string.is_utf8() {
        return Some(Name::Borrowed(string.slice8()));
    }
    let mut out = Vec::with_capacity(string.slice16().len());
    for unit in char::decode_utf16(string.slice16().iter().copied()) {
        // Two lone surrogates are two names: neither is compared.
        let unit = unit.ok()?;
        let mut utf8 = [0u8; 4];
        out.extend_from_slice(unit.encode_utf8(&mut utf8).as_bytes());
    }
    Some(Name::Owned(out))
}

/// ESLint compares the decimal digits of the value: `0x10n` is `16`.
fn of_big_int(digits: &[u8]) -> Option<Name<'_>> {
    let (radix, digits) = match digits {
        [b'0', b'x' | b'X', rest @ ..] => (16, rest),
        [b'0', b'o' | b'O', rest @ ..] => (8, rest),
        [b'0', b'b' | b'B', rest @ ..] => (2, rest),
        _ => (10, digits),
    };
    if radix == 10 {
        if bun_core::strings::index_of_char(digits, b'_').is_none() {
            return Some(Name::Borrowed(digits));
        }
        return Some(Name::Owned(digits.iter().copied().filter(|&digit| digit != b'_').collect()));
    }
    // The conversion is quadratic: a literal longer than this is not compared.
    if digits.len() > 4096 {
        return None;
    }
    // Base 1_000_000_000, the lowest limb first.
    let mut limbs: Vec<u32> = vec![0];
    for &digit in digits {
        if digit == b'_' {
            continue;
        }
        let mut carry = u64::from(char::from(digit).to_digit(radix)?);
        for limb in &mut limbs {
            let value = u64::from(*limb) * u64::from(radix) + carry;
            *limb = (value % 1_000_000_000) as u32;
            carry = value / 1_000_000_000;
        }
        if carry > 0 {
            limbs.push(carry as u32);
        }
    }
    let mut out = Vec::with_capacity(limbs.len() * 9);
    let mut buffer = bun_core::fmt::ItoaBuf::new();
    for (index, limb) in limbs.iter().rev().enumerate() {
        let text = buffer.format(*limb).as_bytes();
        if index > 0 {
            out.extend_from_slice(&b"000000000"[text.len()..]);
        }
        out.extend_from_slice(text);
    }
    Some(Name::Owned(out))
}

/// `String(/a/ig)` is `/a/gi`: the flags in the order of `RegExp.prototype.flags`.
fn of_reg_exp(reg_exp: &E::RegExp) -> Name<'_> {
    let raw = reg_exp.value.slice();
    let flags_at = match reg_exp.flags_offset {
        Some(offset) => usize::from(offset),
        None => raw.len(),
    };
    let Some(flags) = raw.get(flags_at..) else {
        return Name::Borrowed(raw);
    };
    if flags.is_sorted() {
        return Name::Borrowed(raw);
    }
    let mut out = raw.to_vec();
    if let Some(flags) = out.get_mut(flags_at..) {
        flags.sort_unstable();
    }
    Name::Owned(out)
}
