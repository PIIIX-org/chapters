// #475: an edit made from an older revision is merged per line with what
// changed since; only changes that touch the same base lines (or insert at
// the same point) conflict. #408: lines an edit only appended at the end go
// after whatever was added or typed there since.
import { describe, expect, it } from 'vitest'
import { mergeFrontmatter, mergeText, mergeTextKeepingTheirs } from '../src/sync/three-way-merge.js'

const base = 'one\n\ntwo\n\nthree\n'

describe('mergeText', () => {
  it('keeps the base when neither side changed it', () => {
    expect(mergeText(base, base, base)).toEqual({ text: base, concurrent: [] })
  })

  it('takes either side alone, listing only the changes the edit did not make', () => {
    const theirs = base.replace('one', 'ONE')
    expect(mergeText(base, theirs, base)).toEqual({ text: theirs, concurrent: [{ line: 1, removed: 1, added: 1 }] })
    const mine = base.replace('three', 'THREE')
    expect(mergeText(base, base, mine)).toEqual({ text: mine, concurrent: [] })
  })

  it('merges changes to different paragraphs, and to adjacent lines', () => {
    expect(mergeText(base, base.replace('one', 'ONE'), base.replace('three', 'THREE'))).toEqual({
      text: 'ONE\n\ntwo\n\nTHREE\n',
      concurrent: [{ line: 1, removed: 1, added: 1 }],
    })
    expect(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n')).toEqual({ text: 'A\nB\nc\n', concurrent: [{ line: 1, removed: 1, added: 1 }] })
  })

  it('numbers changes in the text as it is now', () => {
    const theirs = `${base}four\n`
    const mine = `zero\nzero again\n${base}`
    expect(mergeText(base, theirs, mine)).toEqual({ text: `zero\nzero again\n${base}four\n`, concurrent: [{ line: 6, removed: 0, added: 1 }] })
  })

  it('conflicts on two changes to one line, even to different words', () => {
    const theirs = 'one\n\ntwo words here\n\nthree\n'
    const merged = mergeText('one\n\ntwo words\n\nthree\n', theirs, 'one\n\nTWO words\n\nthree\n')
    expect(merged).toEqual({ text: null, conflicts: [{ line: 3, removed: 1, added: 1 }] })
  })

  it('numbers a conflict in the current text', () => {
    const theirs = `new\nlines\n${base.replace('three', 'three!')}`
    expect(mergeText(base, theirs, base.replace('three', 'tres'))).toEqual({ text: null, conflicts: [{ line: 7, removed: 1, added: 1 }] })
  })

  it('conflicts on two insertions at one point inside the text, unless they are the same', () => {
    expect(mergeText('a\nb\n', 'a\ntyped\nb\n', 'a\nappended\nb\n')).toEqual({ text: null, conflicts: [{ line: 2, removed: 0, added: 1 }] })
    expect(mergeText(base, `${base}same\n`, `${base}same\n`)).toEqual({ text: `${base}same\n`, concurrent: [] })
  })

  describe('lines the edit appended at the end while the end changed too (#408)', () => {
    it('go after a new last line a person is typing, on a line of their own', () => {
      expect(mergeText(base, `${base}typed`, `${base}appended\n`)).toEqual({ text: `${base}typed\nappended\n`, concurrent: [{ line: 6, removed: 0, added: 1 }] })
      expect(mergeText(base, `${base}theirs\n`, `${base}mine\n`)).toEqual({ text: `${base}theirs\nmine\n`, concurrent: [{ line: 6, removed: 0, added: 1 }] })
    })

    it('go after a last line without a newline that a person extended, which the edit ended (the lab S1 agent)', () => {
      expect(mergeText('a\n a01 a0', 'a\n a01 a02 a', 'a\n a01 a0\nAGENT\n')).toEqual({
        text: 'a\n a01 a02 a\nAGENT\n',
        concurrent: [{ line: 2, removed: 1, added: 1 }],
      })
    })

    it('land when a person deleted the last line', () => {
      expect(mergeText('a\nb', 'a\n', 'a\nb\nc\n')).toEqual({ text: 'a\nc\n', concurrent: [{ line: 2, removed: 1, added: 0 }] })
    })

    it('are not added again when the end already holds them (an append sent twice from one base)', () => {
      expect(mergeText('a\nb', 'a\nb typed\nM1\n', 'a\nb\nM1\nM2\n')).toEqual({ text: 'a\nb typed\nM1\nM2\n', concurrent: [{ line: 2, removed: 1, added: 2 }] })
      expect(mergeText('a\nb', 'a\nb typed\nM1\n', 'a\nb\nM1\n')).toEqual({ text: 'a\nb typed\nM1\n', concurrent: [{ line: 2, removed: 1, added: 2 }] })
    })

    it('conflict when a line they append is already in the changed lines but not at their end (#864 review: resent from an older base)', () => {
      expect(mergeText('a\nb\n', 'a\nb\nAGENT-ONE\nperson\n', 'a\nb\nAGENT-ONE\nAGENT-TWO\n')).toEqual({ text: null, conflicts: [{ line: 3, removed: 0, added: 2 }] })
      expect(mergeText('x\n', 'x\nB1\nA1\nB2\n', 'x\nA1\nA2\n')).toEqual({ text: null, conflicts: [{ line: 2, removed: 0, added: 3 }] })
    })

    it('do not count blank lines as already there', () => {
      expect(mergeText('a\n', 'a\n\nperson\n', 'a\n\nM\n')).toEqual({ text: 'a\n\nperson\n\nM\n', concurrent: [{ line: 2, removed: 0, added: 2 }] })
    })

    it('apply before the per-character fallback of mergeTextKeepingTheirs, which still merges a last line both changed otherwise', () => {
      expect(mergeTextKeepingTheirs('a\nb', 'a\nb typed', 'a\nb\nc\n')).toEqual({ text: 'a\nb typed\nc\n', overlaps: [] })
      expect(mergeTextKeepingTheirs('a\nb', 'a\nbX', 'a\nYb')).toEqual({ text: 'a\nYbX', overlaps: [] })
    })

    it('still conflict when the edit also changed the last line', () => {
      expect(mergeText('a\nb', 'a\nb typed', 'a\nB\nc\n')).toEqual({ text: null, conflicts: [{ line: 2, removed: 1, added: 1 }] })
      expect(mergeText('a\nb', 'a\nb typed', 'a\nbc\n')).toEqual({ text: null, conflicts: [{ line: 2, removed: 1, added: 1 }] })
    })
  })

  it('conflicts on an insertion inside a range the other side replaced', () => {
    const merged = mergeText('a\nb\nc\nd\n', 'a\nX\nd\n', 'a\nb\ninserted\nc\nd\n')
    expect(merged).toEqual({ text: null, conflicts: [{ line: 2, removed: 2, added: 1 }] })
  })

  it('merges an insertion just before or just after a line the other side changed', () => {
    expect(mergeText('a\nb\nc\n', 'a\nB\nc\n', 'a\nnew\nb\nc\n')).toEqual({ text: 'a\nnew\nB\nc\n', concurrent: [{ line: 2, removed: 1, added: 1 }] })
    expect(mergeText('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nnew\nc\n')).toEqual({ text: 'a\nB\nnew\nc\n', concurrent: [{ line: 2, removed: 1, added: 1 }] })
  })

  it('merges a change the edit already holds as one', () => {
    const theirs = base.replace('one', 'ONE')
    expect(mergeText(base, theirs, theirs.replace('three', 'THREE'))).toEqual({ text: 'ONE\n\ntwo\n\nTHREE\n', concurrent: [] })
  })

  it('handles a last line without a newline', () => {
    expect(mergeText('a\nb', 'A\nb', 'a\nb\nc')).toEqual({ text: 'A\nb\nc', concurrent: [{ line: 1, removed: 1, added: 1 }] })
    expect(mergeText('a\nb', 'a\nbx', 'a\nB\nc\n')).toEqual({ text: null, conflicts: [{ line: 2, removed: 1, added: 1 }] })
  })

  it('merges into and from an empty text', () => {
    expect(mergeText('', 'typed\n', '')).toEqual({ text: 'typed\n', concurrent: [{ line: 1, removed: 0, added: 1 }] })
    expect(mergeText('', '', 'written\n')).toEqual({ text: 'written\n', concurrent: [] })
    expect(mergeText('', 'typed', 'written\n')).toEqual({ text: 'typed\nwritten\n', concurrent: [{ line: 1, removed: 0, added: 1 }] })
  })
})

describe('mergeFrontmatter', () => {
  const was = { type: 'docs', title: 'Start', status: 'draft', tags: ['a'] }

  it('keeps keys the edit did not change and applies the ones it did', () => {
    expect(mergeFrontmatter(was, { ...was, title: 'Renamed' }, { ...was, status: 'active' })).toEqual({
      frontmatter: { ...was, title: 'Renamed', status: 'active' },
      concurrent: ['title'],
      conflicts: [],
    })
  })

  it('removes and adds keys on either side', () => {
    const withoutTags = { type: 'docs', title: 'Start', status: 'draft' }
    expect(mergeFrontmatter(was, { ...was, owner: 'me' }, withoutTags)).toEqual({
      frontmatter: { type: 'docs', title: 'Start', status: 'draft', owner: 'me' },
      concurrent: ['owner'],
      conflicts: [],
    })
  })

  it('conflicts on a key both changed to different values, compared whole', () => {
    expect(mergeFrontmatter(was, { ...was, tags: ['a', 'b'] }, { ...was, tags: ['a', 'c'] }).conflicts).toEqual(['tags'])
    expect(mergeFrontmatter(was, { ...was, tags: ['a', 'b'] }, { ...was, tags: ['a', 'b'] }).conflicts).toEqual([])
    const untitled = { type: 'docs', status: 'draft', tags: ['a'] }
    expect(mergeFrontmatter(was, untitled, { ...was, title: 'Agent' }).conflicts).toEqual(['title'])
  })

  it('reads only own keys', () => {
    expect(mergeFrontmatter(was, was, { ...was, constructor: 'x' })).toEqual({
      frontmatter: { ...was, constructor: 'x' },
      concurrent: [],
      conflicts: [],
    })
  })
})
