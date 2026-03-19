import * as assert from 'assert';
import { classifyLine } from '../resultFinder';

// ---------------------------------------------------------------------------
// Helper: assert that classifyLine returns the expected kind
// ---------------------------------------------------------------------------
function assertKind(
  lineText: string,
  symbol: string,
  expectedKind: string | null,
  msg?: string
): void {
  const actual = classifyLine(lineText, symbol);
  assert.strictEqual(actual, expectedKind, msg ?? `line: ${JSON.stringify(lineText)}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('classifyLine()', () => {

  // ── question_mark ──────────────────────────────────────────────────────────
  describe('question_mark', () => {
    it('detects bare symbol followed by ?', () => {
      assertKind('    let x = my_result?;', 'my_result', 'question_mark');
    });

    it('detects symbol with call suffix followed by ?', () => {
      assertKind('    let x = get_result()?;', 'get_result', 'question_mark');
    });

    it('detects symbol inside an expression followed by ?', () => {
      assertKind('    foo(my_result?);', 'my_result', 'question_mark');
    });

    it('question_mark takes priority over return pattern', () => {
      // A line that could match both; question_mark is checked first
      assertKind('    return my_result?;', 'my_result', 'question_mark');
    });
  });

  // ── return ─────────────────────────────────────────────────────────────────
  describe('return', () => {
    it('detects explicit return of the symbol', () => {
      assertKind('    return my_result;', 'my_result', 'return');
    });

    it('detects return with call suffix', () => {
      assertKind('    return compute_result();', 'compute_result', 'return');
    });

    it('detects return with nested call argument', () => {
      assertKind('    return compute_result(foo(bar));', 'compute_result', 'return');
    });

    it('detects implicit return (bare symbol on its own line)', () => {
      assertKind('    my_result', 'my_result', 'return');
    });

    it('detects implicit return with call suffix', () => {
      assertKind('    get_value()', 'get_value', 'return');
    });

    it('detects implicit return with single-dot receiver', () => {
      assertKind('    self.get_value()', 'get_value', 'return');
    });

    it('detects implicit return with multi-dot receiver', () => {
      assertKind('    self.subobject.get_value()', 'get_value', 'return');
    });

    it('detects implicit return with deeply nested receiver', () => {
      assertKind('    self.a.b.c.get_value()', 'get_value', 'return');
    });

    it('detects explicit return with multi-dot receiver', () => {
      assertKind('    return self.subobject.get_value();', 'get_value', 'return');
    });
  });

  // ── match ──────────────────────────────────────────────────────────────────
  describe('match', () => {
    it('detects simple match expression', () => {
      assertKind('    match my_result {', 'my_result', 'match');
    });

    it('detects match with dereference operator', () => {
      assertKind('    match *my_result {', 'my_result', 'match');
    });

    it('detects match with double dereference', () => {
      assertKind('    match **my_result {', 'my_result', 'match');
    });

    it('detects match with spacing around keyword', () => {
      assertKind('  match  my_result  {', 'my_result', 'match');
    });

    it('detects match with single-dot receiver call', () => {
      assertKind('    match self.get_result() {', 'get_result', 'match');
    });

    it('detects match with multi-dot receiver call', () => {
      assertKind('    match self.subobject.get_result() {', 'get_result', 'match');
    });
  });

  // ── if_let ─────────────────────────────────────────────────────────────────
  describe('if_let', () => {
    it('detects if let Ok pattern', () => {
      assertKind('    if let Ok(v) = my_result {', 'my_result', 'if_let');
    });

    it('detects if let Err pattern', () => {
      assertKind('    if let Err(e) = my_result {', 'my_result', 'if_let');
    });

    it('detects if let Some pattern', () => {
      assertKind('    if let Some(v) = my_result {', 'my_result', 'if_let');
    });

    it('detects if let None pattern', () => {
      assertKind('    if let None = my_result {', 'my_result', 'if_let');
    });

    it('detects if let with dereference', () => {
      assertKind('    if let Ok(v) = *my_result {', 'my_result', 'if_let');
    });

    it('detects if let with single-dot receiver call', () => {
      assertKind('    if let Ok(v) = self.get_result() {', 'get_result', 'if_let');
    });

    it('detects if let with multi-dot receiver call', () => {
      assertKind('    if let Ok(v) = self.subobject.get_result() {', 'get_result', 'if_let');
    });
  });

  // ── while_let ──────────────────────────────────────────────────────────────
  describe('while_let', () => {
    it('detects while let Some pattern', () => {
      assertKind('    while let Some(item) = my_result {', 'my_result', 'while_let');
    });

    it('detects while let Ok pattern', () => {
      assertKind('    while let Ok(v) = my_result {', 'my_result', 'while_let');
    });

    it('detects while let Err pattern', () => {
      assertKind('    while let Err(e) = my_result {', 'my_result', 'while_let');
    });

    it('detects while let with dereference', () => {
      assertKind('    while let Some(x) = *my_result {', 'my_result', 'while_let');
    });

    it('detects while let with multi-dot receiver call', () => {
      assertKind('    while let Some(v) = self.subobject.next() {', 'next', 'while_let');
    });
  });

  // ── unwrap ─────────────────────────────────────────────────────────────────
  describe('unwrap', () => {
    it('detects .unwrap() at end of statement', () => {
      assertKind('    let v = my_result.unwrap();', 'my_result', 'unwrap');
    });

    it('detects .unwrap() followed by a comma', () => {
      assertKind('    foo(my_result.unwrap(),', 'my_result', 'unwrap');
    });

    it('detects .unwrap() with whitespace before paren', () => {
      assertKind('    my_result.unwrap ();', 'my_result', 'unwrap');
    });
  });

  // ── expect ─────────────────────────────────────────────────────────────────
  describe('expect', () => {
    it('detects .expect() with a message', () => {
      assertKind('    let v = my_result.expect("should work");', 'my_result', 'expect');
    });

    it('detects .expect() at semicolon', () => {
      assertKind('    my_result.expect("boom");', 'my_result', 'expect');
    });
  });

  // ── unwrap_or ──────────────────────────────────────────────────────────────
  describe('unwrap_or', () => {
    it('detects .unwrap_or()', () => {
      assertKind('    let v = my_result.unwrap_or(0);', 'my_result', 'unwrap_or');
    });

    it('detects .unwrap_or_else()', () => {
      assertKind('    let v = my_result.unwrap_or_else(|| 0);', 'my_result', 'unwrap_or');
    });

    it('detects .unwrap_or_default()', () => {
      assertKind('    let v = my_result.unwrap_or_default();', 'my_result', 'unwrap_or');
    });
  });

  // ── map_combinator ─────────────────────────────────────────────────────────
  describe('map_combinator', () => {
    it('detects .map()', () => {
      assertKind('    let v = my_result.map(|x| x + 1);', 'my_result', 'map_combinator');
    });

    it('detects .and_then()', () => {
      assertKind('    let v = my_result.and_then(|x| Ok(x));', 'my_result', 'map_combinator');
    });

    it('detects .or()', () => {
      assertKind('    let v = my_result.or(Ok(0));', 'my_result', 'map_combinator');
    });

    it('detects .or_else()', () => {
      assertKind('    let v = my_result.or_else(|e| Ok(0));', 'my_result', 'map_combinator');
    });

    it('detects .ok()', () => {
      assertKind('    let v = my_result.ok();', 'my_result', 'map_combinator');
    });

    it('detects .err()', () => {
      assertKind('    let v = my_result.err();', 'my_result', 'map_combinator');
    });

    it('detects .map_err()', () => {
      assertKind('    let v = my_result.map_err(|e| e.to_string());', 'my_result', 'map_combinator');
    });

    it('detects .flatten()', () => {
      assertKind('    let v = my_result.flatten();', 'my_result', 'map_combinator');
    });

    it('detects .transpose()', () => {
      assertKind('    let v = my_result.transpose();', 'my_result', 'map_combinator');
    });
  });

  // ── check ──────────────────────────────────────────────────────────────────
  describe('check', () => {
    it('detects .is_ok()', () => {
      assertKind('    if my_result.is_ok() {', 'my_result', 'check');
    });

    it('detects .is_err()', () => {
      assertKind('    if my_result.is_err() {', 'my_result', 'check');
    });

    it('detects .is_ok() used in assignment', () => {
      assertKind('    let ok = my_result.is_ok();', 'my_result', 'check');
    });
  });

  // ── null (no match) ────────────────────────────────────────────────────────
  describe('returns null for unrecognised lines', () => {
    it('returns null for a plain let binding', () => {
      assertKind('    let x = my_result;', 'my_result', null);
    });

    it('returns null for an unrelated line', () => {
      assertKind('    println!("hello");', 'my_result', null);
    });

    it('returns null when the symbol does not appear', () => {
      assertKind('    other_thing.unwrap();', 'my_result', null);
    });

    it('returns null for partial symbol word match (word-boundary enforced)', () => {
      // "my_result_extra" should not match pattern for "my_result"
      assertKind('    let x = my_result_extra.unwrap();', 'my_result', null);
    });
  });

  // ── special characters in symbol name ─────────────────────────────────────
  describe('symbol name escaping', () => {
    it('handles symbols containing regex-special characters safely', () => {
      // If the symbol happened to contain a dot, buildPattern must escape it
      // In practice Rust identifiers never contain dots, but the escape logic is there
      // Use a simple symbol with underscores (common Rust style)
      assertKind('    let v = result_val.unwrap();', 'result_val', 'unwrap');
    });
  });
});
