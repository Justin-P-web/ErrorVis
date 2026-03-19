import * as assert from 'assert';
import { buildCfgTestLineSet } from '../resultFinder';

describe('buildCfgTestLineSet()', () => {

  it('returns empty set for a file with no cfg(test)', () => {
    const lines = [
      'fn foo() -> Result<i32, ()> {',
      '    Ok(1)',
      '}',
    ];
    assert.deepStrictEqual(buildCfgTestLineSet(lines), new Set());
  });

  it('marks lines inside a #[cfg(test)] mod block', () => {
    const lines = [
      'fn foo() {}',              // 0 — not in test
      '#[cfg(test)]',             // 1 — attribute, not in test
      'mod tests {',              // 2 — mod line itself IS in test block
      '    use super::*;',        // 3 — inside test
      '    #[test]',              // 4 — inside test
      '    fn test_foo() {}',     // 5 — inside test
      '}',                        // 6 — closing brace, NOT in test
      'fn bar() {}',              // 7 — not in test
    ];
    const result = buildCfgTestLineSet(lines);
    assert.ok(!result.has(0), 'line 0 should not be marked');
    assert.ok(!result.has(1), 'line 1 (#[cfg(test)]) should not be marked');
    assert.ok(result.has(2),  'line 2 (mod tests {) should be marked');
    assert.ok(result.has(3),  'line 3 should be marked');
    assert.ok(result.has(4),  'line 4 should be marked');
    assert.ok(result.has(5),  'line 5 should be marked');
    assert.ok(!result.has(6), 'line 6 (closing }) should not be marked');
    assert.ok(!result.has(7), 'line 7 should not be marked');
  });

  it('handles nested braces inside the test block', () => {
    const lines = [
      '#[cfg(test)]',
      'mod tests {',
      '    fn test_nested() {',
      '        if true {',
      '            let _ = 1;',
      '        }',
      '    }',
      '}',
      'fn outside() {}',
    ];
    const result = buildCfgTestLineSet(lines);
    for (let i = 1; i <= 6; i++) {
      assert.ok(result.has(i), `line ${i} should be marked`);
    }
    assert.ok(!result.has(0), 'attribute line should not be marked');
    assert.ok(!result.has(7), 'closing } should not be marked');
    assert.ok(!result.has(8), 'line after block should not be marked');
  });

  it('handles #[cfg(test)] with a blank line between attribute and mod', () => {
    const lines = [
      '#[cfg(test)]',  // 0 — attribute
      '',              // 1 — blank line (does NOT reset pendingCfgTest)
      'mod tests {',   // 2 — mod line, in test block
      '    fn test_foo() {}',  // 3 — inside test
      '}',             // 4 — closing brace, not in test
    ];
    // Blank lines do not reset pendingCfgTest, so the mod is still detected
    const result = buildCfgTestLineSet(lines);
    assert.ok(!result.has(0), 'attribute line should not be marked');
    assert.ok(!result.has(1), 'blank line should not be marked');
    assert.ok(result.has(2),  'mod line should be marked');
    assert.ok(result.has(3),  'fn inside mod should be marked');
    assert.ok(!result.has(4), 'closing } should not be marked');
  });

  it('handles multiple #[cfg(test)] blocks in the same file', () => {
    const lines = [
      'fn foo() {}',        // 0
      '#[cfg(test)]',       // 1
      'mod tests_a {',      // 2
      '    fn a() {}',      // 3
      '}',                  // 4
      'fn bar() {}',        // 5
      '#[cfg(test)]',       // 6
      'mod tests_b {',      // 7
      '    fn b() {}',      // 8
      '}',                  // 9
    ];
    const result = buildCfgTestLineSet(lines);
    assert.ok(!result.has(0));
    assert.ok(!result.has(1));
    assert.ok(result.has(2));
    assert.ok(result.has(3));
    assert.ok(!result.has(4));
    assert.ok(!result.has(5));
    assert.ok(!result.has(6));
    assert.ok(result.has(7));
    assert.ok(result.has(8));
    assert.ok(!result.has(9));
  });

  it('does not mark lines when #[cfg(test)] is followed by a non-mod item', () => {
    const lines = [
      '#[cfg(test)]',
      'fn test_helper() -> Result<(), ()> {',
      '    Ok(())',
      '}',
    ];
    const result = buildCfgTestLineSet(lines);
    assert.deepStrictEqual(result, new Set(), 'non-mod after cfg(test) should not create a test block');
  });

  it('does not mark lines when #[cfg(test)] is on a mod without braces on the same line', () => {
    const lines = [
      '#[cfg(test)]',
      'mod tests',
      '{',
      '    fn test_foo() {}',
      '}',
    ];
    // The mod line doesn't include '{' so pendingCfgTest is reset by the non-empty, non-comment line
    const result = buildCfgTestLineSet(lines);
    assert.deepStrictEqual(result, new Set());
  });

});
