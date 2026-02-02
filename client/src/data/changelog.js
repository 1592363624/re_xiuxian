export const currentVersion = 'v0.0.3_BETA'; // 🔔 发布新版时，请修改此版本号以触发用户弹窗

// 🛡️ 兜底数据：仅在无法连接 GitHub API 时显示
export const changelog = [
  {
    version: 'fallback', 
    date: new Date().toLocaleDateString(),
    sections: [
      {
        title: '获取失败',
        type: 'fix', 
        items: [
          '无法连接到 GitHub 获取最新更新日志。',
          '请检查网络连接，或稍后再试。'
        ]
      },
      {
        title: '版本说明',
        type: 'other',
        items: [
          '当前显示的为本地兜底信息。',
          '实际更新内容请查看代码仓库提交记录。'
        ]
      }
    ]
  }
];
