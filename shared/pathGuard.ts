/**
 * 路径守卫：删除这类动作的输入来自渲染进程，不能它说什么就删什么。
 * 只放行"确实落在某个已添加根目录之内"的绝对路径。
 */

/** 统一成分隔符为 / 、去掉尾部斜杠、小写（Windows 大小写不敏感） */
function normalize(p: string): string {
  return (p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-z]:\//.test(p); // POSIX 或带盘符的 Windows 路径
}

/**
 * target 是否在任一 root 之内。
 * 注意两个坑：① `C:/PhotosEvil` 以 `C:/Photos` 开头但不是它里面的路径，必须比到分隔符；
 * ② root 自身不算"在里面"——删掉整个根目录不是删除一张图片。
 */
export function isInsideRoot(target: string, rootPaths: string[]): boolean {
  const t = normalize(target);
  if (!t || !isAbsolute(t)) return false;
  return rootPaths.some((raw) => {
    const root = normalize(raw);
    return root.length > 0 && isAbsolute(root) && t.startsWith(`${root}/`);
  });
}
