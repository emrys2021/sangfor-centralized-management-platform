import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader, Spinner } from "@/components/common";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { instanceApi } from "@/lib/api";
import type { Instance, InstanceInput } from "@/lib/types";

const emptyForm: InstanceInput = {
  name: "",
  description: "",
  protocol: "https",
  host: "",
  web_port: 443,
  api_port: 9999,
  web_user: "",
  web_password: "",
  api_key: "",
  enabled: true,
};

// 连接测试结果持久化到 localStorage，跨页面跳转 / 刷新保留（测试是用户主动行为）。
type TestResult = { ok: boolean; message: string; at: number };
const TEST_RESULTS_KEY = "sangfor.instance-test-results";

function loadTestResults(): Record<number, TestResult> {
  try {
    return JSON.parse(localStorage.getItem(TEST_RESULTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function relativeTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function InstancesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: instances = [], isLoading } = useQuery({
    queryKey: ["instances"],
    queryFn: () => instanceApi.list(),
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Instance | null>(null);
  const [form, setForm] = useState<InstanceInput>(emptyForm);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, TestResult>>(() => loadTestResults());
  const [changingWebPwd, setChangingWebPwd] = useState(false);
  const [changingApiKey, setChangingApiKey] = useState(false);

  // 更新单条测试结果并落盘
  function recordResult(id: number, r: TestResult) {
    setTestResults((prev) => {
      const next = { ...prev, [id]: r };
      try {
        localStorage.setItem(TEST_RESULTS_KEY, JSON.stringify(next));
      } catch {
        /* localStorage 不可用时忽略，仅内存保留 */
      }
      return next;
    });
  }

  const save = useMutation({
    mutationFn: (data: InstanceInput) =>
      editing ? instanceApi.update(editing.id, data) : instanceApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instances"] });
      setOpen(false);
      toast.success(editing ? "实例已更新" : "实例已创建");
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "保存失败"),
  });

  // 编辑时若密码 / API 密钥留空，则省略该字段（表示保持不变），避免清空已存凭据。
  function submitForm() {
    const payload: InstanceInput = { ...form };
    if (editing) {
      if (!payload.web_password) delete (payload as Partial<InstanceInput>).web_password;
      if (!payload.api_key) delete (payload as Partial<InstanceInput>).api_key;
    }
    save.mutate(payload);
  }

  const remove = useMutation({
    mutationFn: (id: number) => instanceApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["instances"] });
      toast.success("实例已删除");
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail ?? "删除失败"),
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setChangingWebPwd(false);
    setChangingApiKey(false);
    setOpen(true);
  }

  function openEdit(inst: Instance) {
    setEditing(inst);
    setChangingWebPwd(false);
    setChangingApiKey(false);
    setForm({
      name: inst.name,
      description: inst.description,
      protocol: inst.protocol,
      host: inst.host,
      web_port: inst.web_port,
      api_port: inst.api_port,
      web_user: inst.web_user,
      web_password: "",
      api_key: "",
      enabled: inst.enabled,
    });
    setOpen(true);
  }

  async function testConn(inst: Instance) {
    setTestingId(inst.id);
    try {
      const r = await instanceApi.test(inst.id);
      recordResult(inst.id, { ok: r.web_ok, message: r.message ?? "", at: Date.now() });
      if (!r.web_ok) toast.error(`「${inst.name}」连接失败`);
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? "连接测试失败";
      recordResult(inst.id, { ok: false, message: msg, at: Date.now() });
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="实例管理"
        description="维护受管的深信服 AC 实例及其访问凭据。凭据加密存储，不会回显明文。"
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> 新建实例
          </Button>
        }
      />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>地址</TableHead>
              <TableHead>Web / API 端口</TableHead>
              <TableHead>凭据</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>连接</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && instances.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  暂无实例，点击右上角「新建实例」开始。
                </TableCell>
              </TableRow>
            )}
            {instances.map((inst) => (
              <TableRow key={inst.id}>
                <TableCell>
                  <div className="font-medium">{inst.name}</div>
                  {inst.description && (
                    <div className="text-xs text-muted-foreground">{inst.description}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {inst.protocol}://{inst.host}
                </TableCell>
                <TableCell className="text-xs">
                  {inst.web_port} / {inst.api_port}
                </TableCell>
                <TableCell className="space-x-1">
                  {inst.has_web_password ? (
                    <Badge variant="secondary">Web</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground/50">无 Web</Badge>
                  )}
                  {inst.has_api_key ? (
                    <Badge variant="secondary">API</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground/50">无 API</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {inst.enabled ? (
                    <Badge variant="success">启用</Badge>
                  ) : (
                    <Badge variant="secondary">禁用</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {testingId === inst.id ? (
                    <Spinner className="h-3.5 w-3.5" />
                  ) : testResults[inst.id] == null ? (
                    <span className="text-xs text-muted-foreground/40">未测试</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      {testResults[inst.id].ok ? (
                        <Badge variant="success">正常</Badge>
                      ) : (
                        <Badge
                          variant="destructive"
                          className="max-w-[140px] truncate"
                          title={testResults[inst.id].message}
                        >
                          失败
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground/40" title={new Date(testResults[inst.id].at).toLocaleString()}>
                        {relativeTime(testResults[inst.id].at)}
                      </span>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => testConn(inst)} disabled={testingId === inst.id}>
                      <Plug className="h-4 w-4" />
                      测试
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(inst)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: "删除实例",
                            description: `确认删除实例「${inst.name}」？`,
                            variant: "destructive",
                            confirmText: "删除",
                          })
                        )
                          remove.mutate(inst.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑实例" : "新建实例"}</DialogTitle>
            <DialogDescription>
              {editing ? "凭据留空表示保持不变。" : "填写 AC 的访问地址与凭据。"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <Field label="名称">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="主机地址 (IP/域名)">
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            </Field>
            <Field label="协议">
              <Input value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })} />
            </Field>
            <Field label="描述">
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>
            <Field label="Web 端口">
              <Input
                type="number"
                value={form.web_port}
                onChange={(e) => setForm({ ...form, web_port: Number(e.target.value) })}
              />
            </Field>
            <Field label="API 端口">
              <Input
                type="number"
                value={form.api_port}
                onChange={(e) => setForm({ ...form, api_port: Number(e.target.value) })}
              />
            </Field>
            <Field label="Web 用户名">
              <Input value={form.web_user} onChange={(e) => setForm({ ...form, web_user: e.target.value })} />
            </Field>
            <Field label="Web 密码">
              {editing && editing.has_web_password && !changingWebPwd ? (
                <div className="flex gap-2">
                  <Input value="••••••••" readOnly className="font-mono tracking-widest text-muted-foreground flex-1" />
                  <Button type="button" variant="outline" size="sm" onClick={() => setChangingWebPwd(true)}>
                    修改
                  </Button>
                </div>
              ) : (
                <Input
                  type="password"
                  value={form.web_password}
                  placeholder={editing && !editing.has_web_password ? "未设置" : "输入新密码"}
                  onChange={(e) => setForm({ ...form, web_password: e.target.value })}
                  onBlur={() => {
                    // 失焦时若未输入任何内容，则切回黑点（避免误触修改后忘记关闭）
                    if (changingWebPwd && !form.web_password) setChangingWebPwd(false);
                  }}
                  autoFocus={changingWebPwd}
                />
              )}
            </Field>
            <Field label="API 共享密钥">
              {editing && editing.has_api_key && !changingApiKey ? (
                <div className="flex gap-2">
                  <Input value="••••••••" readOnly className="font-mono tracking-widest text-muted-foreground flex-1" />
                  <Button type="button" variant="outline" size="sm" onClick={() => setChangingApiKey(true)}>
                    修改
                  </Button>
                </div>
              ) : (
                <Input
                  type="password"
                  value={form.api_key}
                  placeholder={editing && !editing.has_api_key ? "未设置" : "输入新密钥"}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  onBlur={() => {
                    if (changingApiKey && !form.api_key) setChangingApiKey(false);
                  }}
                  autoFocus={changingApiKey}
                />
              )}
            </Field>
            <div className="flex items-center gap-2 self-end">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                id="enabled"
              />
              <Label htmlFor="enabled">启用</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={submitForm} disabled={save.isPending || !form.name || !form.host}>
              {save.isPending && <Spinner />} 保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
