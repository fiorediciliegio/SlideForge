import { describe, expect, it } from 'vitest';
import { generateGradientSVG, getCssLinearGradientEndpoints } from '../utils.js';
import { buildBackgroundLayerSvg } from '../index.js';

function decodeSvg(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8');
}

describe('radial gradient backgrounds', () => {
  it('converts the PPT-SDK radial background into an SVG radialGradient', () => {
    const dataUrl = generateGradientSVG(
      1280,
      720,
      'radial-gradient(circle, rgb(10, 22, 51) 0%, rgb(5, 10, 26) 100%)',
      0,
      null
    );

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = decodeSvg(dataUrl);
    expect(svg).toContain('<radialGradient');
    expect(svg).toContain('rgb(10, 22, 51)');
    expect(svg).toContain('rgb(5, 10, 26)');
    expect(svg).toContain('scale(640 640)');
  });

  it('supports a positioned ellipse', () => {
    const svg = decodeSvg(
      generateGradientSVG(200, 100, 'radial-gradient(ellipse at 25% 75%, red 0%, blue 100%)', 0, null)
    );

    expect(svg).toContain('translate(50 75)');
    expect(svg).toContain('scale(150 75)');
  });
});

describe('linear gradient angle backgrounds', () => {
  it.each([
    [0, { x1: '50.0%', y1: '100.0%', x2: '50.0%', y2: '0.0%' }],
    [90, { x1: '0.0%', y1: '50.0%', x2: '100.0%', y2: '50.0%' }],
    [180, { x1: '50.0%', y1: '0.0%', x2: '50.0%', y2: '100.0%' }],
    [270, { x1: '100.0%', y1: '50.0%', x2: '0.0%', y2: '50.0%' }],
  ])('maps CSS %ideg to its expected SVG direction', (angle, expected) => {
    expect(getCssLinearGradientEndpoints(1280, 720, angle)).toEqual(expected);
  });

  it('uses the actual rectangle dimensions for diagonal CSS gradients', () => {
    expect(getCssLinearGradientEndpoints(200, 100, 45)).toEqual({
      x1: '12.5%', y1: '125.0%', x2: '87.5%', y2: '-25.0%',
    });
  });

  it('writes CSS 90deg as a left-to-right SVG gradient', () => {
    const svg = decodeSvg(generateGradientSVG(1280, 720, 'linear-gradient(90deg, red 0%, blue 100%)', 0, null));
    expect(svg).toContain('x1="0.0%" y1="50.0%" x2="100.0%" y2="50.0%"');
  });
});

describe('painted background clipping', () => {
  it('copies computed corner radii into the temporary foreignObject box', () => {
    const svg = buildBackgroundLayerSvg(
      {
        backgroundSize: 'auto',
        backgroundRepeat: 'repeat',
        backgroundPosition: '0% 0%',
        borderTopLeftRadius: '50%',
        borderTopRightRadius: '50%',
        borderBottomRightRadius: '50%',
        borderBottomLeftRadius: '50%',
      },
      88,
      88,
      false,
      false,
      'conic-gradient(red 0% 50%, blue 50% 100%)'
    );

    expect(svg).toContain('overflow:hidden');
    expect(svg).toContain('border-top-left-radius:50%');
    expect(svg).toContain('border-top-right-radius:50%');
    expect(svg).toContain('border-bottom-right-radius:50%');
    expect(svg).toContain('border-bottom-left-radius:50%');
  });

  it('does not apply outer-element rounding to an isolated repeat tile', () => {
    const svg = buildBackgroundLayerSvg(
      {
        backgroundSize: '8px 8px',
        backgroundRepeat: 'repeat',
        backgroundPosition: '0% 0%',
        borderTopLeftRadius: '20px',
        borderTopRightRadius: '20px',
        borderBottomRightRadius: '20px',
        borderBottomLeftRadius: '20px',
      },
      8,
      8,
      true,
      false,
      'repeating-linear-gradient(red 0 1px, transparent 1px 8px)'
    );

    expect(svg).not.toContain('border-top-left-radius');
  });
});
