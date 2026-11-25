import { describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-router', () => ({ router: {} }));

/* eslint-disable import/first -- the mock above must be registered before this loads */
import { anchorFromRouteParam, END } from '@/core/clip-anchor';

import { editorParams } from './navigation';
/* eslint-enable import/first */

describe('editorParams', () => {
  it('opens a new editor on the clip tapped in the recorder', () => {
    expect(editorParams('d1', { clipId: 'c2' })).toEqual({ draftId: 'd1', clipId: 'c2' });
  });

  it('else at the insert cursor, as a param the editor route reads back', () => {
    const cursor = { before: 'c2', next: 'c3' };
    const params = editorParams('d1', { anchor: cursor });
    expect(params).toEqual({ draftId: 'd1', anchor: 'before:c2,c3' });
    expect(anchorFromRouteParam(params.anchor)).toEqual(cursor);
    expect(editorParams('d1', { anchor: END })).toEqual({ draftId: 'd1', anchor: 'end' });
  });
});
