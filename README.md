# pair-wise-yy-58 大型构件吊装三维校核平台

围绕大型转换桁架吊装方案，提供三维场景、时间轴校核、冲突定位、条件评论和多角色签署工作流。页面支持拖动旋转吊装场景、编辑步骤参数、处理规则冲突、恢复本地草稿并锁定发布版本。

## 技术栈

Vue 3、Quasar、Pinia、Vue Router、Apollo Client、GraphQL、Three.js、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

端口：`62058`

```bash
npm run build
```

数据草稿保存在浏览器 `localStorage`，Apollo 内存缓存保存吊装方案版本快照。
