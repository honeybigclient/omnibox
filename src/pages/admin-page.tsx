import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, ShieldCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { API_SITES } from "@/config/apiSites";
import type { ApiSite } from "@/types/apiSite";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

interface Me {
  email: string;
  isAdmin: boolean;
  approved?: boolean;
  sources?: string[];
}

interface AdminUser {
  email: string;
  approved: boolean;
  sources: string[];
}

async function apiJson(url: string, options?: RequestInit) {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function readCustomSites(): ApiSite[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("customApiSites") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState("");
  const [approved, setApproved] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const sources = useMemo(() => {
    const all = [...API_SITES, ...readCustomSites()];
    const seen = new Set<string>();
    return all
      .filter((site) => site?.key && site?.api)
      .filter((site) => {
        if (seen.has(site.key)) return false;
        seen.add(site.key);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, []);

  useEffect(() => {
    apiJson("/api/me")
      .then((data: Me) => {
        setMe(data);
        if (data.isAdmin) loadUsers();
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function loadUsers() {
    try {
      const data = await apiJson("/api/admin/users");
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "加载用户失败");
    }
  }

  function resetForm() {
    setEmail("");
    setApproved(true);
    setSelected([]);
  }

  function editUser(user: AdminUser) {
    setEmail(user.email);
    setApproved(user.approved);
    setSelected(user.sources);
  }

  function toggleSource(key: string) {
    setSelected((previous) =>
      previous.includes(key)
        ? previous.filter((item) => item !== key)
        : [...previous, key]
    );
  }

  async function save() {
    const target = email.trim().toLowerCase();
    if (!target.includes("@")) {
      toast.error("请输入有效邮箱");
      return;
    }

    setSaving(true);
    try {
      await apiJson("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: target,
          approved,
          sources: selected,
        }),
      });
      toast.success(`已保存 ${target}`);
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="mr-2 h-6 w-6 animate-spin" />
        正在检查权限...
      </div>
    );
  }

  if (!me?.isAdmin) {
    return (
      <div className="mx-auto mt-16 max-w-xl">
        <Card>
          <CardHeader>
            <CardTitle>没有管理员权限</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>当前账号：{me?.email || "未知"}</p>
            <p>{error || "只有管理员可以管理用户和源权限。"}</p>
            <Button variant="outline" onClick={() => (window.location.hash = "/")}>
              返回首页
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">用户与源权限</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            当前管理员：{me.email}
          </p>
        </div>
        <Button variant="outline" onClick={() => (window.location.hash = "/")}>
          返回首页
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4" />
            添加 / 修改用户
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">
                用户邮箱
              </label>
              <Input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="friend@example.com"
              />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <Checkbox
                checked={approved}
                onCheckedChange={(checked) => setApproved(checked === true)}
              />
              允许使用
            </label>
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              保存
            </Button>
            <Button variant="outline" onClick={resetForm}>
              新增
            </Button>
          </div>

          <div className="rounded-md border border-border/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 p-3">
              <span className="text-sm font-medium">
                可用源（已选 {selected.length} / {sources.length}）
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(sources.map((site) => site.key))}
                >
                  全选
                </Button>
                <Button size="sm" variant="outline" onClick={() => setSelected([])}>
                  清空
                </Button>
              </div>
            </div>
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto p-3 sm:grid-cols-2">
              {sources.map((site) => (
                <label
                  key={site.key}
                  className="flex cursor-pointer items-center gap-2 rounded p-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox
                    checked={selected.includes(site.key)}
                    onCheckedChange={() => toggleSource(site.key)}
                  />
                  <span className="truncate">{site.name}</span>
                  <span className="ml-auto max-w-[40%] truncate text-[10px] text-muted-foreground">
                    {site.key}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            注意：邮箱还必须加入 Cloudflare Access 的 allow-friends 策略，否则连登录页都进不来。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            已配置用户
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有配置普通用户。</p>
          ) : (
            users.map((user) => (
              <div
                key={user.email}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border/50 p-3"
              >
                <div className="min-w-[220px] flex-1">
                  <div className="text-sm font-medium">{user.email}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {user.sources.length} 个源
                  </div>
                </div>
                <Badge variant={user.approved ? "default" : "secondary"}>
                  {user.approved ? "允许" : "禁用"}
                </Badge>
                <Button size="sm" variant="outline" onClick={() => editUser(user)}>
                  编辑
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
