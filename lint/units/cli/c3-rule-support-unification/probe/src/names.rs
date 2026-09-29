//! The name a property key or a member access has without running the program (ESLint: getStaticPropertyName).
use bun_ast::{E, Expr, ExprData};

/// Writes the name into `out` and answers true; false when the key has no static name.
/// `computed`: the key stands in brackets.
pub(crate) fn static_key_name(key: &Expr, computed: bool, arena: &bun_alloc::Arena, out: &mut Vec<u8>) -> bool {
    out.clear();
    match &key.data {
        // An identifier key and a string key are both a string here.
        ExprData::EString(string) => match string.string(arena) {
            Ok(bytes) => {
                out.extend_from_slice(bytes);
                true
            }
            Err(_) => false,
        },
        ExprData::ENumber(number) => {
            let mut buffer = [0u8; 124];
            out.extend_from_slice(bun_core::fmt::FormatDouble::dtoa(&mut buffer, number.value()));
            true
        }
        ExprData::EBigInt(big) => big_int_name(&big.value, out),
        ExprData::ENull(_) if computed => {
            out.extend_from_slice(b"null");
            true
        }
        ExprData::EBoolean(boolean) if computed => {
            out.extend_from_slice(if boolean.value { b"true" } else { b"false" });
            true
        }
        ExprData::ERegExp(regexp) if computed => reg_exp_name(&regexp.value, out),
        ExprData::ETemplate(template) if computed && template.tag.is_none() && template.parts.slice().is_empty() => {
            match &template.head {
                E::TemplateContents::Cooked(string) => match string.string(arena) {
                    Ok(bytes) => {
                        out.extend_from_slice(bytes);
                        true
                    }
                    Err(_) => false,
                },
                E::TemplateContents::Raw(_) => false,
            }
        }
        _ => false,
    }
}

/// The decimal digits of a BigInt literal as written without its `n`.
fn big_int_name(raw: &[u8], out: &mut Vec<u8>) -> bool {
    let digits: Vec<u8> = raw.iter().copied().filter(|&byte| byte != b'_' && byte != b'n').collect();
    let radix = match digits.get(..2) {
        Some(b"0x" | b"0X") => 16,
        Some(b"0o" | b"0O") => 8,
        Some(b"0b" | b"0B") => 2,
        _ => {
            out.extend_from_slice(&digits);
            return true;
        }
    };
    let mut value: u128 = 0;
    for &digit in &digits[2..] {
        let Some(digit) = (digit as char).to_digit(radix) else { return false };
        let Some(next) = value.checked_mul(radix as u128).and_then(|v| v.checked_add(digit as u128)) else {
            // Wider than 128 bits: the spelling stands for the value.
            out.extend_from_slice(&digits.to_ascii_lowercase());
            return true;
        };
        value = next;
    }
    out.extend_from_slice(value.to_string().as_bytes());
    true
}

/// `/pattern/flags` with the flags in the order a RegExp prints them.
fn reg_exp_name(raw: &[u8], out: &mut Vec<u8>) -> bool {
    let Some(slash) = raw.iter().rposition(|&byte| byte == b'/') else { return false };
    out.extend_from_slice(&raw[..=slash]);
    for flag in b"dgimsuvy" {
        if raw[slash + 1..].contains(flag) {
            out.push(*flag);
        }
    }
    true
}

/// The property name of `a.b` or of `a[key]` with a static key.
pub(crate) fn static_member_name(expr: &Expr, arena: &bun_alloc::Arena, out: &mut Vec<u8>) -> bool {
    match &expr.data {
        ExprData::EDot(dot) => {
            out.clear();
            out.extend_from_slice(&dot.name);
            true
        }
        ExprData::EIndex(index) => static_key_name(&index.index, true, arena, out),
        _ => false,
    }
}
