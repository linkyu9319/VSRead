import type { CSSProperties } from 'react';
import type { ReaderSettings } from '../shared/model';

export function customThemeStyle(settings: ReaderSettings): CSSProperties | undefined {
  if (settings.theme !== 'custom') return undefined;
  const background = settings.backgroundColor;
  const foreground = settings.textColor;
  const components = background.slice(1).match(/../g)!.map(part => parseInt(part, 16) / 255);
  const light = components[0] * .2126 + components[1] * .7152 + components[2] * .0722 > .55;
  return {
    '--bg': background, '--fg': foreground,
    '--panel': `color-mix(in srgb, ${background} 96%, ${foreground})`,
    '--border': `color-mix(in srgb, ${foreground} 17%, ${background})`,
    '--muted': `color-mix(in srgb, ${foreground} 70%, ${background})`,
    '--accent': light ? '#397b63' : '#83b8a5',
    '--button-fg': light ? '#ffffff' : '#142c22',
    colorScheme: light ? 'light' : 'dark',
  } as CSSProperties;
}
