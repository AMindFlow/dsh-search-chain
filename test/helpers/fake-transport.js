// transport 工厂替身：链为每个实际尝试的条目 open(entry) 取 handle（A6），
// 条目结束（成功/失败/超时）后必须 handle.close()（CFG-004 旧连接在结束后释放）。
// 路由细节（直连/固定代理/PAC）在 network-contract 用真实 createEntryTransport + fake fetch 验证；
// 链级测试只断言「每条目恰好 open 一次与其 close 生命周期」。

/**
 * @param {{ fetchImpl?: Function }} [opts] fetchImpl: 共享的 createFakeFetch 产物。
 */
export function createFakeTransportFactory(opts = {}) {
  const handles = [];
  const factory = {
    handles,
    openedEntryIds: [],
    open(entry, openOpts = {}) {
      const handle = {
        entry,
        opts: openOpts,
        fetch: opts.fetchImpl,
        closed: false,
        closeCount: 0,
        close() {
          handle.closed = true;
          handle.closeCount += 1;
        },
      };
      handles.push(handle);
      factory.openedEntryIds.push(entry.id);
      return handle;
    },
    handleFor(entryId) {
      return handles.filter((h) => h.entry.id === entryId);
    },
    allClosed() {
      return handles.every((h) => h.closed);
    },
    openCount() {
      return handles.length;
    },
  };
  return factory;
}
