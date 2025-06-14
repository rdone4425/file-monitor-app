import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import crypto from 'crypto';  // 内置的crypto模块
import { logger } from './logger.js';
import { MultiFileMonitor } from './multi-file-monitor.js';
import { GitHubApiService } from './github-api.js';
import { AdvancedMonitoringConfig } from './advanced-config.js';
import { AuthMiddleware } from './auth-middleware.js';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 应用根目录
const appRoot = path.dirname(__dirname);

// 文件组配置路径
const fileGroupsPath = path.join(appRoot, 'file-groups.json');
const advancedConfigPath = path.join(appRoot, 'advanced-config.json');

// 创建唯一ID的函数，替代uuid
function generateUniqueId() {
  return 'fg_' + crypto.randomBytes(16).toString('hex');
}

// 创建路由
const router = express.Router();

// 创建多文件监控实例
const multiFileMonitor = new MultiFileMonitor();

// 创建身份验证中间件实例
const authMiddleware = new AuthMiddleware();

// 加载高级配置
const advancedConfig = new AdvancedMonitoringConfig(advancedConfigPath);

// 文件组数据
let fileGroups = [];

/**
 * 初始化
 */
async function initialize() {
  try {
    // 加载高级配置
    await advancedConfig.loadConfig();
    
    // 加载文件组
    await loadFileGroups();
    
    // 启动已激活的文件组监控
    await startActiveFileGroups();
    
    logger.info('多文件监控系统初始化完成');
  } catch (error) {
    logger.error(`多文件监控系统初始化失败: ${error.message}`);
  }
}

/**
 * 加载文件组配置
 */
async function loadFileGroups() {
  try {
    if (existsSync(fileGroupsPath)) {
      const data = await fs.readFile(fileGroupsPath, 'utf-8');
      fileGroups = JSON.parse(data);
      logger.info(`已加载 ${fileGroups.length} 个文件组配置`);
    } else {
      fileGroups = [];
      await saveFileGroups();
      logger.info('创建了新的文件组配置文件');
    }
  } catch (error) {
    logger.error(`加载文件组配置失败: ${error.message}`);
    fileGroups = [];
  }
}

/**
 * 保存文件组配置
 */
async function saveFileGroups() {
  try {
    await fs.writeFile(fileGroupsPath, JSON.stringify(fileGroups, null, 2), 'utf-8');
    logger.info('文件组配置已保存');
    return true;
  } catch (error) {
    logger.error(`保存文件组配置失败: ${error.message}`);
    return false;
  }
}

/**
 * 启动活跃的文件组监控
 */
async function startActiveFileGroups() {
  for (const group of fileGroups) {
    if (group.status === 'active') {
      await startFileGroupMonitoring(group);
    }
  }
}

/**
 * 开始监控文件组
 * @param {Object} group - 文件组配置
 */
async function startFileGroupMonitoring(group) {
  try {
    if (!group || !group.id) {
      logger.error('无效的文件组配置');
      return false;
    }
    
    // 重新检查状态
    if (group.status !== 'active') {
      logger.info(`文件组 "${group.name}" (${group.id}) 不是活跃状态，跳过启动`);
      return false;
    }
    
    // 获取环境变量
    const githubToken = process.env.GITHUB_TOKEN;
    const githubUsername = process.env.GITHUB_USERNAME;
    
    // 检查GitHub凭据
    if (!githubToken || !githubUsername || 
        githubToken === 'default_token_please_change' ||
        githubUsername === 'default_username_please_change') {
      logger.error(`文件组 "${group.name}" (${group.id}) 无法启动: GitHub凭据无效`);
      return false;
    }
    
    // 添加每个路径为单独的监控
    for (const [index, filePath] of group.paths.entries()) {
      // 生成监控ID
      const monitorId = `${group.id}_${index}`;
      
      // 解析忽略模式
      const ignoredPatterns = group.ignoredPatterns
        ? group.ignoredPatterns.split(',')
        : ['node_modules', '.git', '*.tmp'];
      
      // 添加监控
      const success = multiFileMonitor.addWatchPath(
        monitorId,
        filePath,
        ignoredPatterns,
        group.priority || 'medium',
        {
          groupId: group.id,
          groupName: group.name,
          targetRepo: group.targetRepo,
          commitMessage: group.commitMessage || '自动备份: 文件更新'
        }
      );
      
      if (success) {
        logger.info(`文件组 "${group.name}" 路径 "${filePath}" 监控已启动`);
      } else {
        logger.error(`文件组 "${group.name}" 路径 "${filePath}" 监控启动失败`);
      }
    }
    
    return true;
  } catch (error) {
    logger.error(`启动文件组监控失败 "${group.name}": ${error.message}`);
    return false;
  }
}

/**
 * 停止文件组监控
 * @param {string} groupId - 文件组ID
 */
async function stopFileGroupMonitoring(groupId) {
  try {
    // 查找组
    const group = fileGroups.find(g => g.id === groupId);
    if (!group) {
      logger.error(`停止监控失败: 找不到ID为 ${groupId} 的文件组`);
      return false;
    }
    
    // 检查组中的每个监控路径
    for (let i = 0; i < group.paths.length; i++) {
      const monitorId = `${groupId}_${i}`;
      multiFileMonitor.removeWatchPath(monitorId);
    }
    
    // 更新组状态
    group.status = 'inactive';
    await saveFileGroups();
    
    logger.info(`文件组 "${group.name}" (${groupId}) 的监控已停止`);
    return true;
  } catch (error) {
    logger.error(`停止文件组监控失败 (${groupId}): ${error.message}`);
    return false;
  }
}

/**
 * 处理监控到的文件变化
 */
multiFileMonitor.onFileChange(async function(change) {
  try {
    logger.info(`检测到文件变化: ${change.files.length} 个文件，优先级 ${change.priority}`);
    
    const { watcherId, files, metadata } = change;
    
    if (!metadata || !metadata.groupId) {
      logger.error(`无效的监控元数据: ${watcherId}`);
      return;
    }
    
    // 查找组
    const group = fileGroups.find(g => g.id === metadata.groupId);
    if (!group) {
      logger.error(`找不到ID为 ${metadata.groupId} 的文件组`);
      return;
    }
    
    // 获取GitHub凭据
    const githubToken = process.env.GITHUB_TOKEN;
    const githubUsername = process.env.GITHUB_USERNAME;
    
    // 创建GitHub服务实例
    const githubService = new GitHubApiService(
      githubToken,
      githubUsername,
      metadata.targetRepo || group.targetRepo,
      'main'
    );
    
    // 验证token
    const isTokenValid = await githubService.validateToken();
    if (!isTokenValid) {
      logger.error(`GitHub Token无效，无法处理文件变化`);
      return;
    }
    
    // 准备提交消息
    const commitMessage = (metadata.commitMessage || group.commitMessage || '自动备份: 文件更新')
      .replace('[文件组]', group.name);
    
    // 监控的路径（用于计算相对路径）
    const monitorPath = group.paths[parseInt(watcherId.split('_')[1])];
    
    // 处理文件变化
    for (const filePath of files) {
      try {
        // 检查文件是否存在（如果不存在，说明被删除了）
        const fileExists = existsSync(filePath);
        
        if (fileExists) {
          // 计算相对路径
          let relativePath;
          
          // 判断是监控单个文件还是目录
          try {
            const stats = await fs.stat(monitorPath);
            if (stats.isFile()) {
              // 如果监控的是单个文件，使用文件名
              relativePath = path.basename(filePath);
            } else {
              // 如果监控的是目录，计算相对路径
              // 确保使用正确的路径分隔符
              const normalizedMonitorPath = monitorPath.replace(/\\/g, path.sep);
              const normalizedFilePath = filePath.replace(/\\/g, path.sep);
              relativePath = path.relative(normalizedMonitorPath, normalizedFilePath);
              // 确保使用正斜杠
              relativePath = relativePath.replace(/\\/g, '/');
            }
          } catch (error) {
            logger.error(`计算相对路径失败: ${error.message}`);
            relativePath = path.basename(filePath);
          }
          
          // 上传文件
          logger.info(`上传文件: ${filePath} 到 ${relativePath}`);
          await githubService.uploadFile(filePath, relativePath, commitMessage);
        } else {
          // 文件被删除，从GitHub删除
          logger.info(`文件已删除: ${filePath}，从GitHub删除`);
          
          // 计算相对路径
          let relativePath;
          try {
            const stats = await fs.stat(monitorPath);
            if (stats.isFile()) {
              relativePath = path.basename(filePath);
            } else {
              // 确保使用正确的路径分隔符
              const normalizedMonitorPath = monitorPath.replace(/\\/g, path.sep);
              const normalizedFilePath = filePath.replace(/\\/g, path.sep);
              relativePath = path.relative(normalizedMonitorPath, normalizedFilePath).replace(/\\/g, '/');
            }
          } catch (error) {
            relativePath = path.basename(filePath);
          }
          
          // 从GitHub删除文件
          await githubService.deleteFile(relativePath, `删除文件: ${relativePath}`);
        }
      } catch (error) {
        logger.error(`处理文件 ${filePath} 失败: ${error.message}`);
      }
    }
    
    // 更新组的最后更新时间
    group.lastUpdate = new Date().toISOString();
    await saveFileGroups();
    
  } catch (error) {
    logger.error(`处理文件变化失败: ${error.message}`);
  }
});

// 路由: 获取所有文件组
router.get('/api/file-groups', authMiddleware.requireApiKey(['read']), async (req, res) => {
  try {
    res.json({
      success: true,
      groups: fileGroups
    });
  } catch (error) {
    logger.error(`获取文件组列表失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 获取单个文件组
router.get('/api/file-groups/:id', authMiddleware.requireApiKey(['read']), async (req, res) => {
  try {
    const groupId = req.params.id;
    const group = fileGroups.find(g => g.id === groupId);
    
    if (!group) {
      return res.status(404).json({
        success: false,
        error: '文件组不存在'
      });
    }
    
    // 增强组信息（添加监控路径的状态）
    const enhancedGroup = { ...group };
    enhancedGroup.paths = await Promise.all(
      group.paths.map(async (path) => {
        try {
          const stats = await fs.stat(path);
          return {
            path,
            isDirectory: stats.isDirectory(),
            lastModified: stats.mtime.toISOString(),
            status: 'ok'
          };
        } catch (error) {
          return {
            path,
            isDirectory: false,
            status: 'warning',
            lastModified: null
          };
        }
      })
    );
    
    // 获取活动记录（这里可以从日志或其他地方获取）
    enhancedGroup.activities = [];
    
    res.json({
      success: true,
      group: enhancedGroup
    });
  } catch (error) {
    logger.error(`获取文件组详情失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 创建文件组
router.post('/api/file-groups', authMiddleware.requireApiKey(['write']), async (req, res) => {
  try {
    const { name, priority, targetRepo, ignoredPatterns, commitMessage, startMonitoring, paths } = req.body;
    
    // 验证必要字段
    if (!name || !targetRepo || !paths || !paths.length) {
      return res.status(400).json({
        success: false,
        error: '缺少必要字段'
      });
    }
    
    // 检查路径是否存在
    for (const path of paths) {
      if (!existsSync(path)) {
        return res.status(400).json({
          success: false,
          error: `路径不存在: ${path}`
        });
      }
    }
    
    // 创建新文件组
    const newGroup = {
      id: generateUniqueId(), // 使用自定义ID生成器
      name,
      priority: priority || 'medium',
      targetRepo,
      ignoredPatterns: ignoredPatterns || 'node_modules,.git,*.tmp',
      commitMessage: commitMessage || '自动备份: [文件组] 文件更新',
      status: startMonitoring ? 'active' : 'inactive',
      paths,
      createdAt: new Date().toISOString(),
      lastUpdate: null
    };
    
    // 添加到文件组列表
    fileGroups.push(newGroup);
    
    // 保存文件组
    await saveFileGroups();
    
    // 如果需要启动监控
    if (startMonitoring) {
      await startFileGroupMonitoring(newGroup);
    }
    
    res.json({
      success: true,
      group: newGroup
    });
  } catch (error) {
    logger.error(`创建文件组失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 切换文件组监控状态
router.post('/api/file-groups/:id/toggle', authMiddleware.requireApiKey(['write']), async (req, res) => {
  try {
    const groupId = req.params.id;
    const group = fileGroups.find(g => g.id === groupId);
    
    if (!group) {
      return res.status(404).json({
        success: false,
        error: '文件组不存在'
      });
    }
    
    // 切换状态
    if (group.status === 'active') {
      // 停止监控
      await stopFileGroupMonitoring(groupId);
    } else {
      // 启动监控
      group.status = 'active';
      await saveFileGroups();
      await startFileGroupMonitoring(group);
    }
    
    res.json({
      success: true,
      status: group.status
    });
  } catch (error) {
    logger.error(`切换监控状态失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 删除文件组
router.delete('/api/file-groups/:id', authMiddleware.requireApiKey(['write']), async (req, res) => {
  try {
    const groupId = req.params.id;
    const groupIndex = fileGroups.findIndex(g => g.id === groupId);
    
    if (groupIndex === -1) {
      return res.status(404).json({
        success: false,
        error: '文件组不存在'
      });
    }
    
    // 停止监控
    await stopFileGroupMonitoring(groupId);
    
    // 从列表中移除
    fileGroups.splice(groupIndex, 1);
    
    // 保存更改
    await saveFileGroups();
    
    res.json({
      success: true
    });
  } catch (error) {
    logger.error(`删除文件组失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 获取高级配置
router.get('/api/file-groups/config', authMiddleware.requireApiKey(['read']), async (req, res) => {
  try {
    res.json({
      success: true,
      config: advancedConfig.config
    });
  } catch (error) {
    logger.error(`获取高级配置失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 保存高级配置
router.post('/api/file-groups/config', authMiddleware.requireApiKey(['write', 'admin']), async (req, res) => {
  try {
    const newConfig = req.body;
    
    // 更新配置
    advancedConfig.config = {
      ...advancedConfig.config,
      ...newConfig
    };
    
    // 保存配置
    const saved = await advancedConfig.saveConfig();
    
    if (saved) {
      res.json({
        success: true,
        config: advancedConfig.config
      });
    } else {
      res.status(500).json({
        success: false,
        error: '无法保存配置'
      });
    }
  } catch (error) {
    logger.error(`保存高级配置失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '服务器错误'
    });
  }
});

// 路由: 浏览文件/目录
router.get('/api/browse-path', authMiddleware.requireApiKey(['read']), (req, res) => {
  // 这个接口应该由前端调用，使用系统对话框选择文件/目录
  // 在实际实现中，可能需要其他方式来解决，这里只是一个占位符
  res.json({
    success: true,
    path: 'C:/example/path'
  });
});

// 路由: 渲染多文件管理页面
router.get('/multi-file', async (req, res) => {
  try {
    // 加载最新的文件组
    await loadFileGroups();
    
    // 按优先级分组
    const highPriorityGroups = fileGroups.filter(g => g.priority === 'high');
    const mediumPriorityGroups = fileGroups.filter(g => g.priority === 'medium');
    const lowPriorityGroups = fileGroups.filter(g => g.priority === 'low');
    
    res.render('multi-file-manager', {
      title: '多文件监控管理',
      highPriorityGroups,
      mediumPriorityGroups,
      lowPriorityGroups,
      allGroups: fileGroups,
      config: {
        githubUsername: process.env.GITHUB_USERNAME || 'unknown',
        isConfigured: process.env.GITHUB_TOKEN && process.env.GITHUB_USERNAME
      }
    });
  } catch (error) {
    logger.error(`渲染多文件管理页面失败: ${error.message}`);
    res.status(500).send('服务器错误');
  }
});

// 初始化
initialize();

export default router; 