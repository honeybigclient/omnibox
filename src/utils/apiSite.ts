import { API_SITES } from '@/config/apiSites';
import { getMe } from './auth';

export function getSelectedApiSites(): string[] {
  let keys: string[] = [API_SITES[0].key];

  const saved = localStorage.getItem('selectedApiSites');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) keys = parsed;
    } catch {
      // 忽略坏数据，使用默认源
    }
  }

  const me = getMe();
  if (!me) return keys;
  if (me.isAdmin || me.sources.includes('*')) return keys;
  if (!me.approved) return [];

  const allowed = keys.filter(
    (key) =>
      me.sources.includes(key) ||
      (me.sources.includes("huangguo") && String(key).startsWith("hg_"))
  );
  // 如果本地选中的源刚好都没有权限，默认用账号被授权的全部源
  return allowed.length ? allowed : me.sources;
}

export function setSelectedApiSites(keys: string[]) {
  localStorage.setItem('selectedApiSites', JSON.stringify(keys));
}
