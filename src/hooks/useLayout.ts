import { useWindowDimensions } from 'react-native';

export function useLayout() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isTablet = width >= 600;
  const isWide = width >= 768;
  const contentMaxWidth = isWide ? 720 : isTablet ? 600 : undefined;
  // Explicit horizontal margin to center content — more reliable than alignSelf+maxWidth+flex:1
  const contentHPad = contentMaxWidth ? Math.max(0, Math.floor((width - contentMaxWidth) / 2)) : 0;
  const numColumns = isWide ? 3 : isTablet ? 2 : 1;
  return { width, height, isLandscape, isTablet, isWide, contentMaxWidth, contentHPad, numColumns };
}
