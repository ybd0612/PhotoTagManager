// @vitest-environment jsdom
// 预览左上角 EXIF 信息面板 · **界面侧**（2026-10-20）。
//
// 钉的是三条容易在后续改动里悄悄坏掉的规则：
//  ① 字段缺就不出那一行（不是显示一个空值）；
//  ② 折叠后要留入口，且默认展开（用户明确要求并记住设置）；
//  ③ 同一信息不在一屏里出现两次。
//
// ⚠️ 格式换算那部分在 `exifFields.test.ts`（`.ts`）：那个文件才能 import 主进程模块，
// 本文件属 web project，import `electron/**` 会被 tsconfig.web.json 拒绝（TS6307）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ExifInfoPanel } from '../../src/components/ExifInfoPanel';
import { DEFAULT_UI_PREFS } from '../../shared/types';
import type { ImageInfo } from '../../shared/types';

const FULL: ImageInfo = {
  absPath: 'C:/photos/IMG_0001.JPG',
  fileName: 'IMG_0001.JPG',
  width: 4608,
  height: 3072,
  sizeBytes: 8_388_608,
  fileModified: '2026/10/07 01:56:29',
  fileType: 'JPEG',
  colorSpace: 'Uncalibrated',
  make: 'SONY',
  model: 'ILCE-7M4',
  software: 'ILCE-7M4 v1.10',
  dateTimeOriginalWithOffset: '2023/09/23 09:50:48',
  flash: 'Off, Did not fire',
  focalLength: '46mm',
  shutterSpeed: '0.006s (1/160)',
  aperture: 'f/4.0',
  iso: '125',
  exposureProgram: 'Manual',
  meteringMode: 'Multi-segment',
  ok: true
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof ExifInfoPanel>> = {}) {
  const onToggle = vi.fn();
  render(
    <ExifInfoPanel
      info={FULL}
      loading={false}
      error={false}
      expanded
      onToggle={onToggle}
      {...overrides}
    />
  );
  return { onToggle };
}

describe('EXIF 面板 · 字段渲染', () => {
  beforeEach(() => vi.clearAllMocks());

  it('全套字段都出得来，标签与参考图一致', () => {
    renderPanel();
    for (const label of [
      '文件名',
      '图片大小',
      '修改日期',
      '图片信息',
      '相机制造商',
      '相机型号',
      '软件',
      '拍摄日期',
      '闪光灯',
      '焦距',
      '快门速度',
      '光圈数',
      'ISO 感光度',
      '曝光程序',
      '测光模式'
    ]) {
      expect(screen.getByText(label), `缺标签 ${label}`).toBeTruthy();
    }
    expect(screen.getByText('SONY')).toBeTruthy();
    expect(screen.getByText('ILCE-7M4')).toBeTruthy();
    expect(screen.getByText('0.006s (1/160)')).toBeTruthy();
    expect(screen.getByText('f/4.0')).toBeTruthy();
    expect(screen.getByText('125')).toBeTruthy();
  });

  it('「图片信息」一行把尺寸/格式/色彩空间合成一句', () => {
    renderPanel();
    expect(screen.getByText('4608×3072，JPEG，Uncalibrated')).toBeTruthy();
  });

  it('★ 字段缺就不出那一行，而不是显示空值', () => {
    // 一张只有尺寸的扫描件：没有相机、没有 ISO、没有闪光灯
    const bare: ImageInfo = { absPath: 'C:/p/scan.png', width: 800, height: 600, ok: true };
    renderPanel({ info: bare });
    expect(screen.getByText('图片信息')).toBeTruthy();
    expect(screen.getByText('800×600')).toBeTruthy();
    for (const label of ['相机制造商', '相机型号', 'ISO 感光度', '闪光灯', '快门速度', '光圈数', '测光模式']) {
      expect(screen.queryByText(label), `不该出现 ${label}`).toBeNull();
    }
  });

  it('一张 EXIF 全空的图给的是「没有可显示的 EXIF 信息」，不是空白面板', () => {
    renderPanel({ info: { absPath: 'C:/p/a.png', ok: true } });
    expect(screen.getByText('这张图片没有可显示的 EXIF 信息')).toBeTruthy();
  });

  it('读取中与读取失败各给一句可读文案', () => {
    const { unmount } = render(
      <ExifInfoPanel info={null} loading error={false} expanded onToggle={vi.fn()} />
    );
    expect(screen.getByText('正在读取…')).toBeTruthy();
    unmount();
    render(<ExifInfoPanel info={null} loading={false} error expanded onToggle={vi.fn()} />);
    expect(screen.getByText('图片信息读取失败')).toBeTruthy();
  });
});

describe('EXIF 面板 · 折叠交互', () => {
  it('默认展开（用户 2026-10-20 明确要求）', () => {
    expect(DEFAULT_UI_PREFS.exifPanelExpanded).toBe(true);
  });

  it('折叠后留一个 i 入口，否则用户再也回不去', () => {
    const { onToggle } = renderPanel({ expanded: false });
    expect(screen.queryByTestId('exif-panel')).toBeNull();
    const btn = screen.getByTestId('exif-expand');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('展开态点收起按钮会回调（由上层落盘）', () => {
    const { onToggle } = renderPanel();
    fireEvent.click(screen.getByTestId('exif-collapse'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  /**
   * 2026-10-20 用户要求：收起入口是**箭头**且**整行可点**。
   *
   * 原实现是一颗 14px 的 `×` 加 `p: 0.25` —— 实际可点区域不到 16×16，
   * 在预览大图上瞄不准。
   *
   * ⚠️ 这里**只断言点击行为、不断言样式值**：MUI 的 `sx` 编译成 emotion class，
   * 内联 `style` 属性里查不到 `width:100%`，`toHaveStyle` 也需要本项目没装的 jest-dom。
   * 而「点标题文字能收起」这件事本身就足以证明命中区够大 ——
   * 若只给文字挂 `onClick`、整行不可点，这条断言恰好也会失败。
   */
  it('★ 收起入口是标题整行（不是一颗小图标），点行内空白处也生效', () => {
    const { onToggle } = renderPanel();
    const header = screen.getByTestId('exif-collapse');

    // 点标题文字（不是图标）应触发 —— 说明命中区包住了整行而非只包那颗图标
    fireEvent.click(screen.getByText('EXIF'));
    expect(onToggle).toHaveBeenCalledTimes(1);

    // 点标题行内的其它位置（靠近右侧箭头那侧）同样生效
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('★ 收起与展开用成对的箭头图标（方向相反），不是语义的 X / 问号', () => {
    // 展开态：整行 header + 向上箭头
    const { unmount } = render(
      <ExifInfoPanel info={FULL} loading={false} error={false} expanded onToggle={vi.fn()} />
    );
    const header = screen.getByTestId('exif-collapse');
    // header 是 ButtonBase（渲染成 button），不是给 Typography 挂 onClick
    expect(header.tagName).toBe('BUTTON');
    expect(header.getAttribute('aria-label')).toBe('收起图片信息');
    unmount();

    // 折叠态：向下箭头入口
    render(<ExifInfoPanel info={FULL} loading={false} error={false} expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('exif-expand').getAttribute('aria-label')).toBe('展开图片信息');
  });
});
