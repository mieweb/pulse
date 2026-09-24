import type { ClipCrop } from '@/utils/segment-window';

export type Size = { width: number; height: number };
export type Rect = Size & { left: number; top: number };

/** A clip's geometry edit (see `clipRender`). */
export type GeometryEdit = { rotation: number; flipped: boolean; crop: ClipCrop | null };

export type PreviewGeometry = {
  /** The visible — cropped — picture, fitted into the stage and centred (clips its content). */
  box: Rect;
  /** The video view inside `box`: the un-rotated picture, positioned so that, once transformed,
   *  the crop lands exactly on the box. */
  video: Rect & {
    transform: [{ scaleX: number }, { rotate: string }];
  };
};

/** True when the edit changes the picture's geometry (and so needs `previewGeometry`). */
export const hasGeometry = (e: GeometryEdit) =>
  e.rotation % 4 !== 0 || e.flipped || e.crop !== null;

/**
 * Lay out an edited clip the way the export renders it: the source (its display size, i.e.
 * after its own rotation matrix) turned counter-clockwise `rotation` quarter turns, mirrored if
 * `flipped`, cropped to `crop` (normalized to the rotated frame), then fitted into the stage with
 * bars — the export's pinned canvas centre-pads the same way. Mirrors RNVT's editor, which
 * previews edits as plain view transforms.
 *
 * Null until the stage and source have a size.
 */
export function previewGeometry(
  stage: Size,
  source: Size,
  edit: GeometryEdit,
): PreviewGeometry | null {
  if (stage.width <= 0 || stage.height <= 0 || source.width <= 0 || source.height <= 0) return null;
  const turns = ((Math.round(edit.rotation) % 4) + 4) % 4;
  const odd = turns % 2 === 1;
  // The rotated frame, in source units.
  const rotW = odd ? source.height : source.width;
  const rotH = odd ? source.width : source.height;
  const crop = edit.crop ?? { x: 0, y: 0, w: 1, h: 1 };

  // Fit the cropped picture into the stage (contain).
  const k = Math.min(stage.width / (rotW * crop.w), stage.height / (rotH * crop.h));
  const boxW = rotW * crop.w * k;
  const boxH = rotH * crop.h * k;
  const box = {
    left: (stage.width - boxW) / 2,
    top: (stage.height - boxH) / 2,
    width: boxW,
    height: boxH,
  };

  // The whole rotated frame at that scale, offset so the crop's origin sits at the box origin;
  // the video view is centred on it at its un-rotated size, and the transform (applied about its
  // centre) turns it into place.
  const frameLeft = -crop.x * rotW * k;
  const frameTop = -crop.y * rotH * k;
  const cx = frameLeft + (rotW * k) / 2;
  const cy = frameTop + (rotH * k) / 2;
  const videoW = source.width * k;
  const videoH = source.height * k;
  return {
    box,
    video: {
      left: cx - videoW / 2,
      top: cy - videoH / 2,
      width: videoW,
      height: videoH,
      // Listed transforms apply right to left: rotate (negative = counter-clockwise) first, then
      // mirror — the export's `transpose… , hflip` order.
      transform: [{ scaleX: edit.flipped ? -1 : 1 }, { rotate: `${-90 * turns}deg` }],
    },
  };
}
