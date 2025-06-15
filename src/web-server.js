import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import fs_sync from 'fs';
import { execSync } from 'child_process';
import { logger } from './logger.js';
import { GitHubApiService } from './github-api.js';
import { ConfigValidator } from './config-validator.js';
import { performanceMonitor } from './performance-monitor.js';
import { FileFilter } from './file-filter.js';
import { notificationSystem } from './notification-system.js';
import { authMiddleware } from './auth-middleware.js';
import dotenv from 'dotenv';
import axios from 'axios';
import os from 'os';
import { createWatcher } from './watcher.js';
import { initialize } from './initialize.js';
import multiFileRoutes from './multi-file-routes.js';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 应用根目录
const appRoot = path.dirname(__dirname);

// 获取环境变量
dotenv.config();

// 存储活跃的监控任务
const activeMonitoringTasks = new Map();

/**
 * 从绝对路径获取相对路径，并确保使用正确的路径分隔符
 * @param {string} filePath - 文件绝对路径
 * @param {string} basePath - 基础路径
 * @returns {string} - 相对路径
 */
function getRelativePath(filePath, basePath) {
  // 确保使用正确的路径分隔符
  const normalizedFilePath = filePath.replace(/\\/g, path.sep);
  const normalizedBasePath = basePath.replace(/\\/g, path.sep);
  
  // 获取相对路径
  const relativePath = path.relative(normalizedBasePath, normalizedFilePath);
  
  // 统一使用正斜杠作为路径分隔符（GitHub 使用正斜杠）
  return relativePath.replace(/\\/g, '/');
}

/**
 * 启动项目监控
 * @param {object} project - 项目配置
 * @returns {boolean} - 是否成功启动
 */
async function startMonitoringTask(project) {
  try {
    if (activeMonitoringTasks.has(project.id)) {
      logger.info(`项目 "${project.name}" 的监控任务已存在，先停止旧任务`);
      await stopMonitoringTask(project.id);
    }
    
    // 验证路径
    const pathExists = existsSync(project.path);
    if (!pathExists) {
      logger.warn(`项目 "${project.name}" 的路径不存在: ${project.path}`);
      logger.info(`将继续尝试监控，但在路径创建前不会检测到任何变化`);
    }
    
    // 获取环境变量
    const githubToken = process.env.GITHUB_TOKEN;
    const githubUsername = process.env.GITHUB_USERNAME;
    
    // 检查GitHub凭据是否为默认值
    const isDefaultToken = githubToken === 'default_token_please_change' || 
                           githubToken === 'default_token_for_startup';
    const isDefaultUsername = githubUsername === 'default_username_please_change' || 
                              githubUsername === 'default_username_for_startup';
    
    // GitHub集成是否可用
    const githubIntegrationEnabled = githubToken && githubUsername && 
                                     !isDefaultToken && !isDefaultUsername;
    
    if (!githubIntegrationEnabled) {
      logger.warn(`项目 "${project.name}": GitHub集成不可用 - 使用了默认凭据或缺少凭据`);
      logger.warn('文件变化将被监控但不会上传到GitHub');
    }
    
    // 忽略的文件/文件夹模式
    const ignoredPatterns = project.ignoredPatterns
      ? project.ignoredPatterns.split(',')
      : ['node_modules', '.git', '*.tmp'];

    // 配置延迟提交时间（毫秒）
    const debounceTime = 2000;

    // 创建文件过滤器
    const fileFilter = new FileFilter({
      maxFileSize: project.maxFileSize || 50 * 1024 * 1024, // 50MB 默认
      ignoredPatterns: ignoredPatterns,
      blockedExtensions: ['.exe', '.dll', '.so', '.dylib', '.bin'],
      allowedExtensions: project.allowedExtensions ? project.allowedExtensions.split(',') : []
    });
    
    let githubService = null;
    
    // 只有在GitHub集成启用时才初始化GitHub服务
    if (githubIntegrationEnabled) {
      // 初始化 GitHub API 服务
      githubService = new GitHubApiService(
        githubToken,
        githubUsername,
        project.repo,
        project.branch
      );
      
      // 验证 token 有效性
      const isTokenValid = await githubService.validateToken();
      if (!isTokenValid) {
        logger.error(`项目 "${project.name}": GitHub Token 无效，禁用GitHub集成`);
        githubService = null;
        githubIntegrationEnabled = false;
      }
    }
    
    // 检查路径类型
    let isFile = false;
    try {
      if (pathExists) {
        const stats = await fs.stat(project.path);
        isFile = stats.isFile();
      }
    } catch (error) {
      logger.error(`无法获取路径信息: ${project.path}, 错误: ${error.message}`);
      logger.warn('将假设这是一个目录路径');
    }
    
    logger.info(`启动项目 "${project.name}" 的文件监控`);
    logger.info(`监控路径: ${project.path}`);
    
    if (githubIntegrationEnabled) {
      logger.info(`GitHub 仓库: ${githubUsername}/${project.repo}`);
      logger.info(`GitHub 分支: ${project.branch}`);
    } else {
      logger.info('GitHub集成已禁用，文件变化只会在本地监控');
    }
    
    // 创建并启动文件监控
    const watcher = createWatcher(project.path, ignoredPatterns, debounceTime, async (changedFiles) => {
      try {
        logger.info(`项目 "${project.name}" 检测到文件变化: ${changedFiles.length} 个文件被修改`);

        // 记录文件变化到性能监控
        performanceMonitor.recordFileChanges(changedFiles.length);

        // 发送文件变化通知
        await notificationSystem.notify('file_change', {
          projectName: project.name,
          fileCount: changedFiles.length,
          files: changedFiles.map(f => path.basename(f))
        });

        // 如果GitHub集成不可用，只记录变化但不上传
        if (!githubIntegrationEnabled || !githubService) {
          logger.info(`项目 "${project.name}" 检测到文件变化，但由于GitHub集成不可用，文件未上传`);
          // 更新项目的最后更新时间
          await updateProjectLastUpdateTime(project.id);
          return;
        }
        
        if (changedFiles.length > 0) {
          // 过滤文件
          const existingFiles = changedFiles.filter(file => {
            const exists = fs_sync.existsSync(file);
            if (!exists) {
              logger.warn(`跳过不存在的文件: ${file}`);
            }
            return exists;
          });
          
          const filterResult = await fileFilter.filterFiles(existingFiles);

          logger.info(`项目 "${project.name}" 文件过滤结果: ${filterResult.stats.allowed} 允许, ${filterResult.stats.filtered} 过滤`);

          // 记录被过滤的文件
          if (filterResult.filtered.length > 0) {
            logger.debug(`被过滤的文件:`);
            filterResult.filtered.forEach(f => {
              logger.debug(`  - ${f.path}: ${f.reason}`);
            });
          }

          // 准备上传文件
          const filesToUpload = filterResult.allowed.map(file => {
            // 如果监控的是单个文件，直接使用文件名作为仓库路径
            const repoPath = isFile ? path.basename(file.path) : getRelativePath(file.path, project.path);
            return {
              localPath: file.path,
              repoPath: repoPath
            };
          });
          
          // 上传文件
          if (filesToUpload.length > 0) {
            const uploadStartTime = Date.now();
            const uploadResults = await githubService.uploadFiles(filesToUpload, project.commitMessage);
            const uploadTime = Date.now() - uploadStartTime;

            // 输出上传结果
            const successCount = uploadResults.filter(r => r.success).length;
            const failCount = uploadResults.length - successCount;

            logger.info(`项目 "${project.name}" 上传完成: ${successCount} 成功, ${failCount} 失败，耗时: ${uploadTime}ms`);
            
            // 记录失败的文件
            if (failCount > 0) {
              uploadResults
                .filter(r => !r.success)
                .forEach(r => {
                  logger.error(`文件 ${r.file.repoPath} 上传失败: ${r.error}`);
                });
            }
          } else {
            logger.warn(`项目 "${project.name}" 没有有效的文件可上传`);
          }
          
          // 更新项目的最后更新时间
          await updateProjectLastUpdateTime(project.id);
        }
      } catch (error) {
        logger.error(`项目 "${project.name}" GitHub 操作失败: ${error.message}`);
      }
    });
    
    // 存储监控任务
    activeMonitoringTasks.set(project.id, {
      watcher,
      project
    });
    
    return true;
  } catch (error) {
    logger.error(`启动项目 "${project.name}" 监控失败: ${error.message}`);
    return false;
  }
}

/**
 * 停止项目监控
 * @param {string} projectId - 项目ID
 * @returns {boolean} - 是否成功停止
 */
async function stopMonitoringTask(projectId) {
  try {
    if (!activeMonitoringTasks.has(projectId)) {
      logger.warn(`尝试停止不存在的监控任务: ${projectId}`);
      return false;
    }
    
    const { watcher, project } = activeMonitoringTasks.get(projectId);
    
    // 停止文件监控
    watcher.close();
    
    // 从活跃任务中移除
    activeMonitoringTasks.delete(projectId);
    
    logger.info(`项目 "${project.name}" 的监控已停止`);

    // 发送项目停止通知
    await notificationSystem.notify('project_stopped', {
      projectName: project.name,
      reason: '手动停止'
    });

    return true;
  } catch (error) {
    logger.error(`停止项目监控失败: ${error.message}`);
    return false;
  }
}

/**
 * 更新项目的最后更新时间
 * @param {string} projectId - 项目ID
 */
async function updateProjectLastUpdateTime(projectId) {
  try {
    const projectsPath = path.join(appRoot, 'projects.json');
    
    if (!existsSync(projectsPath)) {
      return;
    }
    
    // 读取项目列表
    const projectsData = await fs.readFile(projectsPath, 'utf8');
    const projects = JSON.parse(projectsData);
    
    // 查找项目
    const projectIndex = projects.findIndex(p => p.id === projectId);
    if (projectIndex === -1) {
      return;
    }
    
    // 更新最后更新时间
    projects[projectIndex].lastUpdate = new Date().toLocaleString();
    
    // 保存更新后的项目列表
    await fs.writeFile(projectsPath, JSON.stringify(projects, null, 2));
  } catch (error) {
    logger.error(`更新项目最后更新时间失败: ${error.message}`);
  }
}

/**
 * 执行项目初始文件上传
 * @param {object} project - 项目配置
 * @returns {Promise<boolean>} - 是否成功上传
 */
async function initialProjectUpload(project) {
  try {
    logger.info(`开始执行项目 "${project.name}" 的初始文件上传...`);
    
    try {
      // 验证路径存在
      if (!existsSync(project.path)) {
        logger.error(`项目 "${project.name}" 的路径不存在: ${project.path}`);
        return false;
      }
      
      // 获取环境变量
      const githubToken = process.env.GITHUB_TOKEN;
      const githubUsername = process.env.GITHUB_USERNAME;
      
      // 检查GitHub凭据是否为默认值
      const isDefaultToken = githubToken === 'default_token_please_change' || 
                             githubToken === 'default_token_for_startup';
      const isDefaultUsername = githubUsername === 'default_username_please_change' || 
                                githubUsername === 'default_username_for_startup';
      
      // GitHub集成是否可用
      const githubIntegrationEnabled = githubToken && githubUsername && 
                                       !isDefaultToken && !isDefaultUsername;
      
      if (!githubIntegrationEnabled) {
        logger.warn(`项目 "${project.name}": GitHub集成不可用 - 使用了默认凭据或缺少凭据`);
        logger.warn('无法执行初始文件上传');
        return false;
      }
      
      // 初始化 GitHub API 服务
      const githubService = new GitHubApiService(
        githubToken,
        githubUsername,
        project.repo,
        project.branch
      );
      
      // 验证 token 有效性
      const isTokenValid = await githubService.validateToken();
      if (!isTokenValid) {
        logger.error(`项目 "${project.name}" GitHub Token 无效，无法执行初始上传`);
        return false;
      }
      
      // 检查路径是文件还是目录
      const stats = await fs.stat(project.path);
      
      if (stats.isFile()) {
        // 路径是文件，直接上传
        const filename = path.basename(project.path);
        
        logger.info(`项目 "${project.name}" 是单个文件，准备上传: ${filename}`);
        
        const filesToUpload = [{
          localPath: project.path,
          repoPath: filename
        }];
        
        // 上传文件
        const uploadResults = await githubService.uploadFiles(filesToUpload, project.commitMessage || 'Initial commit');
        
        // 输出上传结果
        const successCount = uploadResults.filter(r => r.success).length;
        const failCount = uploadResults.length - successCount;
        
        logger.info(`项目 "${project.name}" 初始上传完成: ${successCount} 成功, ${failCount} 失败`);
        
        // 记录失败的文件
        if (failCount > 0) {
          uploadResults
            .filter(r => !r.success)
            .forEach(r => logger.error(`项目 "${project.name}" 文件 ${r.file.repoPath} 上传失败: ${r.error}`));
        }
        
        // 更新项目的最后更新时间
        await updateProjectLastUpdateTime(project.id);
        
        return successCount > 0;
      } else if (stats.isDirectory()) {
        // 路径是目录，递归上传所有文件
        
        // 忽略的文件/文件夹模式
        const ignoredPatterns = project.ignoredPatterns 
          ? project.ignoredPatterns.split(',') 
          : ['node_modules', '.git', '*.tmp'];
        
        logger.info(`项目 "${project.name}" 是目录，准备递归上传所有文件`);
        logger.info(`忽略的模式: ${ignoredPatterns.join(', ')}`);
        
        // 获取目录中的所有文件（递归）
        const getAllFiles = async (dirPath, ignorePatterns) => {
          const files = [];
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            
            // 检查是否应该忽略
            const shouldIgnore = ignorePatterns.some(pattern => {
              if (pattern.startsWith('*')) {
                const ext = pattern.substring(1);
                return entry.name.endsWith(ext);
              }
              return entry.name === pattern;
            });
            
            if (shouldIgnore) {
              continue;
            }
            
            if (entry.isDirectory()) {
              const subDirFiles = await getAllFiles(fullPath, ignorePatterns);
              files.push(...subDirFiles);
            } else {
              files.push(fullPath);
            }
          }
          
          return files;
        };
        
        // 获取所有文件
        const allFiles = await getAllFiles(project.path, ignoredPatterns);
        
        if (allFiles.length === 0) {
          logger.info(`项目 "${project.name}" 没有找到需要上传的文件`);
          return true;
        }
        
        logger.info(`项目 "${project.name}" 找到 ${allFiles.length} 个文件需要上传`);
        
        // 准备上传文件
        const filesToUpload = allFiles.map(file => ({
          localPath: file,
          repoPath: getRelativePath(file, project.path)
        }));
        
        // 上传文件
        const uploadResults = await githubService.uploadFiles(filesToUpload, project.commitMessage || 'Initial commit');
        
        // 输出上传结果
        const successCount = uploadResults.filter(r => r.success).length;
        const failCount = uploadResults.length - successCount;
        
        logger.info(`项目 "${project.name}" 初始上传完成: ${successCount} 成功, ${failCount} 失败`);
        
        // 记录失败的文件
        if (failCount > 0) {
          uploadResults
            .filter(r => !r.success)
            .forEach(r => logger.error(`项目 "${project.name}" 文件 ${r.file.repoPath} 上传失败: ${r.error}`));
        }
        
        // 更新项目的最后更新时间
        await updateProjectLastUpdateTime(project.id);
        
        return successCount > 0;
      } else {
        logger.error(`项目 "${project.name}" 路径既不是文件也不是目录: ${project.path}`);
        return false;
      }
    } catch (error) {
      logger.error(`项目 "${project.name}" 初始上传失败: ${error.message}`);
      return false;
    }
  } catch (error) {
    logger.error(`执行项目 "${project.name}" 初始上传时发生错误: ${error.message}`);
    return false;
  }
}

/**
 * 启动所有活跃项目的监控
 */
async function startAllActiveProjects() {
  try {
    const projectsPath = path.join(appRoot, 'projects.json');
    
    if (!existsSync(projectsPath)) {
      logger.info('没有找到项目配置文件，跳过启动项目监控');
      return;
    }
    
    // 读取项目列表
    const projectsData = await fs.readFile(projectsPath, 'utf8');
    const projects = JSON.parse(projectsData);
    
    // 过滤出活跃的项目
    const activeProjects = projects.filter(p => p.status === 'active');
    
    if (activeProjects.length === 0) {
      logger.info('没有找到活跃的项目，跳过启动项目监控');
      return;
    }
    
    logger.info(`找到 ${activeProjects.length} 个活跃项目，正在启动监控...`);
    
    // 启动每个活跃项目的监控
    for (const project of activeProjects) {
      await startMonitoringTask(project);
    }
  } catch (error) {
    logger.error(`启动所有活跃项目监控失败: ${error.message}`);
  }
}

/**
 * 格式化文件大小
 * @param {number} bytes - 文件大小（字节）
 * @returns {string} - 格式化后的文件大小
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 获取系统信息
 * @returns {object} - 系统信息对象
 */
function getSystemInfo() {
  try {
    return {
      platform: os.platform(), // 'win32', 'darwin', 'linux'等
      type: os.type(),         // 'Windows_NT', 'Darwin', 'Linux'等
      release: os.release(),   // 版本号
      arch: os.arch(),         // 架构
      hostname: os.hostname(), // 主机名
      homedir: os.homedir(),   // 用户主目录
      tmpdir: os.tmpdir(),     // 临时目录
      cpus: os.cpus().length,  // CPU核心数
      totalMemory: formatFileSize(os.totalmem()), // 总内存
      freeMemory: formatFileSize(os.freemem())    // 可用内存
    };
  } catch (error) {
    logger.error(`获取系统信息失败: ${error.message}`);
    // 返回一个安全的默认值
    return {
      platform: 'unknown',
      type: 'unknown',
      release: 'unknown',
      arch: 'unknown',
      hostname: 'unknown',
      homedir: '/',
      tmpdir: '/tmp',
      cpus: 1,
      totalMemory: 'unknown',
      freeMemory: 'unknown'
    };
  }
}

/**
 * 获取系统根目录
 * @param {string} platform - 操作系统平台
 * @returns {string[]} - 系统根目录数组
 */
function getSystemRoots(platform) {
  try {
    if (platform === 'win32') {
      // Windows系统，获取所有驱动器
      try {
        // 常见的 Windows 驱动器盘符
        const possibleDrives = ['A:', 'B:', 'C:', 'D:', 'E:', 'F:', 'G:', 'H:', 'I:', 'J:', 'K:', 'L:', 'M:', 
                               'N:', 'O:', 'P:', 'Q:', 'R:', 'S:', 'T:', 'U:', 'V:', 'W:', 'X:', 'Y:', 'Z:'];
        
        // 检查哪些驱动器实际存在
        const drives = [];
        for (const drive of possibleDrives) {
          try {
            // 尝试检查驱动器是否存在
            if (existsSync(drive + path.sep)) {
              drives.push(drive);
            }
          } catch (err) {
            // 忽略错误，继续检查其他驱动器
            logger.debug(`检查驱动器 ${drive} 时出错: ${err.message}`);
          }
        }
        
        // 如果没有找到任何驱动器，至少返回 C:
        return drives.length > 0 ? drives : ['C:'];
      } catch (error) {
        logger.error(`获取Windows驱动器列表失败: ${error.message}`);
        return ['C:'];
      }
    } else {
      // Linux/Mac系统
      // 检查常见的 Linux 目录
      const commonDirs = [
        '/',
        '/home',
        '/root',
        '/var',
        '/etc',
        '/usr',
        '/opt',
        '/app'
      ];
      
      // 安全地检查目录是否存在和可访问
      const availableDirs = [];
      for (const dir of commonDirs) {
        try {
          // 检查目录是否存在
          if (existsSync(dir)) {
            // 尝试检查目录是否可读
            try {
              const testRead = fs_sync.readdirSync(dir, { withFileTypes: true });
              // 如果能够读取目录内容，则添加到可用目录列表
              availableDirs.push(dir);
            } catch (readErr) {
              // 目录存在但无法读取（可能是权限问题）
              // 仍然添加到列表中，但会在UI中标记为可能需要权限
              logger.warn(`目录 ${dir} 存在但无法读取: ${readErr.message}`);
              availableDirs.push({
                path: dir,
                restricted: true,
                error: readErr.code
              });
            }
          }
        } catch (err) {
          logger.warn(`检查目录 ${dir} 时出错: ${err.message}`);
          // 即使出错，也添加到列表中，但标记为受限
          availableDirs.push({
            path: dir,
            restricted: true,
            error: err.code || 'UNKNOWN'
          });
        }
      }
      
      // 如果没有找到任何可用目录，至少返回根目录
      if (availableDirs.length === 0) {
        logger.warn('未找到任何可用目录，返回根目录');
        return [{
          path: '/',
          restricted: true,
          error: 'NO_DIRS_FOUND'
        }];
      }
      
      return availableDirs;
    }
  } catch (error) {
    logger.error(`获取系统根目录失败: ${error.message}`);
    // 返回一个安全的默认值
    return platform === 'win32' ? ['C:'] : ['/'];
  }
}

export async function startServer(port = 3000) {
  // 初始化应用程序
  const initSuccess = await initialize();
  if (!initSuccess) {
    logger.error("应用程序初始化失败，无法启动服务器");
    process.exit(1);
  }

  // 验证配置
  logger.info("正在验证配置...");
  const configValidation = ConfigValidator.logValidationResult();

  if (!configValidation.isValid) {
    logger.warn("配置验证失败，但应用将继续启动。请检查配置以确保功能正常。");
  }
  
  // 首先检查环境变量，并输出状态信息
  const githubToken = process.env.GITHUB_TOKEN || '';
  const githubUsername = process.env.GITHUB_USERNAME || '';
  
  // 检查GitHub凭据是否为默认值
  const isDefaultToken = githubToken === 'default_token_please_change' || 
                       githubToken === 'default_token_for_startup';
  const isDefaultUsername = githubUsername === 'default_username_please_change' || 
                          githubUsername === 'default_username_for_startup';
  
  // GitHub集成是否可用
  const githubIntegrationEnabled = githubToken && githubUsername && 
                                 !isDefaultToken && !isDefaultUsername;
  
  logger.info('文件监控应用程序启动中...');
  if (githubIntegrationEnabled) {
    logger.info(`GitHub集成已启用 - 用户: ${githubUsername}`);
  } else {
    logger.warn('GitHub集成未启用 - 使用了默认凭据或缺少必要的环境变量');
    logger.warn('应用程序将正常启动，但GitHub相关功能将不可用');
    logger.warn('要启用GitHub集成，请在.env文件中设置GITHUB_TOKEN和GITHUB_USERNAME');
  }
  
  const app = express();
  
  // 设置模板引擎
  app.set('view engine', 'ejs');
  app.set('views', path.join(appRoot, 'views'));
  
  // 中间件设置
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());
  app.use(express.static(path.join(appRoot, 'public')));
  
  // 注册多文件监控路由
  app.use(multiFileRoutes);
  
  // 健康检查端点
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // 性能监控 API (需要认证)
  app.get('/api/performance', authMiddleware.requireApiKey(['read']), (req, res) => {
    try {
      const stats = performanceMonitor.getStats();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error(`获取性能数据失败: ${error.message}`);
      res.status(500).json({
        success: false,
        error: '获取性能数据失败'
      });
    }
  });

  // 配置验证 API
  app.get('/api/config/validate', (req, res) => {
    try {
      const validation = ConfigValidator.validateEnvironmentConfig();
      res.json({
        success: true,
        data: validation
      });
    } catch (error) {
      logger.error(`配置验证失败: ${error.message}`);
      res.status(500).json({
        success: false,
        error: '配置验证失败'
      });
    }
  });

  // 通知系统状态 API
  app.get('/api/notifications/status', (req, res) => {
    try {
      const status = notificationSystem.getStatus();
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      logger.error(`获取通知状态失败: ${error.message}`);
      res.status(500).json({
        success: false,
        error: '获取通知状态失败'
      });
    }
  });

  // 测试通知 API (需要管理员权限)
  app.post('/api/notifications/test', authMiddleware.requireApiKey(['admin']), async (req, res) => {
    try {
      const { provider = 'webhook' } = req.body;

      const result = await notificationSystem.notify('system_error', {
        errorMessage: '这是一个测试通知',
        timestamp: new Date().toISOString()
      }, [provider]);

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error(`发送测试通知失败: ${error.message}`);
      res.status(500).json({
        success: false,
        error: '发送测试通知失败: ' + error.message
      });
    }
  });

  // 认证统计 API (需要管理员权限)
  app.get('/api/auth/stats', authMiddleware.requireApiKey(['admin']), (req, res) => {
    try {
      const stats = authMiddleware.getStats();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error(`获取认证统计失败: ${error.message}`);
      res.status(500).json({
        success: false,
        error: '获取认证统计失败'
      });
    }
  });

  // 添加全局辅助函数
  app.use((req, res, next) => {
    res.locals.formatFileSize = formatFileSize;
    next();
  });

  // 仪表盘页面 - 获取项目列表
  app.get('/', async (req, res) => {
    try {
      // 获取环境变量信息
      const githubToken = process.env.GITHUB_TOKEN || '';
      const githubUsername = process.env.GITHUB_USERNAME || '';
      
      // 检查GitHub凭据是否为默认值
      const isDefaultToken = githubToken === 'default_token_please_change' || 
                           githubToken === 'default_token_for_startup';
      const isDefaultUsername = githubUsername === 'default_username_please_change' || 
                              githubUsername === 'default_username_for_startup';
      
      // 配置信息
      const config = {
        githubToken,
        githubUsername,
        githubRepo: process.env.GITHUB_REPO || '',
        watchPath: process.env.WATCH_PATH || '',
        isConfigured: githubToken && githubUsername && !isDefaultToken && !isDefaultUsername
      };
      
      // 获取项目列表
      let projects = [];
      try {
        const projectsPath = path.join(appRoot, 'projects.json');
        if (existsSync(projectsPath)) {
          const projectsData = await fs.readFile(projectsPath, 'utf8');
          projects = JSON.parse(projectsData);
        }
      } catch (error) {
        logger.error(`读取项目列表错误: ${error.message}`);
      }
      
      // 使用 EJS 模板渲染页面
      res.render('dashboard-new', { 
        config, 
        monitoringTasks: projects,
        // 添加多文件监控功能链接
        showMultiFileLink: true
      });
    } catch (error) {
      logger.error(`渲染仪表盘页面错误: ${error.message}`);
      res.status(500).send('服务器错误');
    }
  });
  
  // 保留旧版仪表盘页面 - 用于后续比较
  app.get('/dashboard-old', async (req, res) => {
    try {
      // 获取环境变量信息
      const config = {
        githubToken: process.env.GITHUB_TOKEN || '',
        githubUsername: process.env.GITHUB_USERNAME || '',
        githubRepo: process.env.GITHUB_REPO || '',
        watchPath: process.env.WATCH_PATH || '',
        isConfigured: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_USERNAME)
      };
      
      // 获取项目列表
      let projects = [];
      try {
        const projectsPath = path.join(appRoot, 'projects.json');
        if (existsSync(projectsPath)) {
          const projectsData = await fs.readFile(projectsPath, 'utf8');
          projects = JSON.parse(projectsData);
        }
      } catch (error) {
        logger.error(`读取项目列表错误: ${error.message}`);
      }
      
      res.render('dashboard', { 
        config, 
        monitoringTasks: projects 
      });
    } catch (error) {
      logger.error(`渲染仪表盘页面错误: ${error.message}`);
      res.status(500).send('服务器错误');
    }
  });
  
  // 创建新项目的API
  app.post('/api/projects', async (req, res) => {
    try {
      const {
        name,
        path: projectPath,
        repo,
        branch,
        commitMessage,
        ignoredPatterns,
        startNow
      } = req.body;
      
      // 验证必填字段
      if (!name || !projectPath || !repo) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少必要字段' 
        });
      }
      
      // 验证路径存在
      if (!existsSync(projectPath)) {
        return res.status(400).json({ 
          success: false, 
          error: '指定的路径不存在' 
        });
      }
      
      // 读取现有项目列表
      let projects = [];
      const projectsPath = path.join(appRoot, 'projects.json');
      
      if (existsSync(projectsPath)) {
        const projectsData = await fs.readFile(projectsPath, 'utf8');
        projects = JSON.parse(projectsData);
      }
      
      // 检查项目名称是否已存在
      if (projects.some(p => p.name === name)) {
        return res.status(400).json({ 
          success: false, 
          error: '项目名称已存在' 
        });
      }
      
      // 创建新项目对象
      const newProject = {
        id: Date.now().toString(),
        name,
        path: projectPath,
        repo: repo,
        branch: branch || 'main',
        commitMessage: commitMessage || 'Auto-commit: 文件更新',
        ignoredPatterns: ignoredPatterns || 'node_modules,.git,*.tmp',
        status: startNow ? 'active' : 'stopped',
        lastUpdate: new Date().toLocaleString(),
        createdAt: new Date().toLocaleString()
      };
      
      // 添加到项目列表
      projects.push(newProject);
      
      // 保存更新后的项目列表
      await fs.writeFile(projectsPath, JSON.stringify(projects, null, 2));
      
      // 如果项目路径中有文件，执行初始上传
      await initialProjectUpload(newProject);
      
      // 如果设置为立即启动，启动监控
      if (startNow) {
        await startMonitoringTask(newProject);
      }
      
      res.json({ 
        success: true, 
        project: newProject 
      });
    } catch (error) {
      logger.error(`创建项目错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 获取项目列表API
  app.get('/api/projects', async (req, res) => {
    try {
      const projectsPath = path.join(appRoot, 'projects.json');
      let projects = [];
      
      if (existsSync(projectsPath)) {
        const projectsData = await fs.readFile(projectsPath, 'utf8');
        projects = JSON.parse(projectsData);
      }
      
      res.json({ 
        success: true, 
        projects 
      });
    } catch (error) {
      logger.error(`获取项目列表错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 获取单个项目API
  app.get('/api/projects/:id', async (req, res) => {
    try {
      const projectId = req.params.id;
      const projectsPath = path.join(appRoot, 'projects.json');
      
      if (!existsSync(projectsPath)) {
        return res.status(404).json({ 
          success: false, 
          error: '项目列表不存在' 
        });
      }
      
      // 读取项目列表
      const projectsData = await fs.readFile(projectsPath, 'utf8');
      const projects = JSON.parse(projectsData);
      
      // 查找项目
      const project = projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ 
          success: false, 
          error: '找不到指定项目' 
        });
      }
      
      res.json({ 
        success: true, 
        project 
      });
    } catch (error) {
      logger.error(`获取项目信息错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 更新项目API
  app.put('/api/projects/:id', async (req, res) => {
    try {
      const projectId = req.params.id;
      const projectsPath = path.join(appRoot, 'projects.json');
      
      if (!existsSync(projectsPath)) {
        return res.status(404).json({ 
          success: false, 
          error: '项目列表不存在' 
        });
      }
      
      // 验证必填字段
      const {
        name,
        path: projectPath,
        repo,
        branch,
        commitMessage,
        ignoredPatterns
      } = req.body;
      
      if (!name || !projectPath || !repo) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少必要字段' 
        });
      }
      
      // 验证路径存在
      if (!existsSync(projectPath)) {
        return res.status(400).json({ 
          success: false, 
          error: '指定的路径不存在' 
        });
      }
      
      // 读取项目列表
      const projectsData = await fs.readFile(projectsPath, 'utf8');
      const projects = JSON.parse(projectsData);
      
      // 查找项目
      const projectIndex = projects.findIndex(p => p.id === projectId);
      if (projectIndex === -1) {
        return res.status(404).json({ 
          success: false, 
          error: '找不到指定项目' 
        });
      }
      
      // 检查项目名称是否已被其他项目使用
      if (projects.some(p => p.name === name && p.id !== projectId)) {
        return res.status(400).json({ 
          success: false, 
          error: '项目名称已存在' 
        });
      }
      
      // 更新项目信息
      const project = projects[projectIndex];
      project.name = name;
      project.path = projectPath;
      project.repo = repo;
      project.branch = branch || 'main';
      project.commitMessage = commitMessage || 'Auto-commit: 文件更新';
      project.ignoredPatterns = ignoredPatterns || 'node_modules,.git,*.tmp';
      project.lastUpdate = new Date().toLocaleString();
      
      // 保存更新后的项目列表
      await fs.writeFile(projectsPath, JSON.stringify(projects, null, 2));
      
      logger.info(`已更新项目 "${name}" 的信息`);
      
      res.json({ 
        success: true, 
        project 
      });
    } catch (error) {
      logger.error(`更新项目错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 切换项目状态API
  app.post('/api/projects/:id/toggle', async (req, res) => {
    try {
      const projectId = req.params.id;
      const projectsPath = path.join(appRoot, 'projects.json');
      
      if (!existsSync(projectsPath)) {
        return res.status(404).json({ 
          success: false, 
          error: '项目列表不存在' 
        });
      }
      
      // 读取项目列表
      const projectsData = await fs.readFile(projectsPath, 'utf8');
      const projects = JSON.parse(projectsData);
      
      // 查找项目
      const projectIndex = projects.findIndex(p => p.id === projectId);
      if (projectIndex === -1) {
        return res.status(404).json({ 
          success: false, 
          error: '找不到指定项目' 
        });
      }
      
      // 切换状态
      const project = projects[projectIndex];
      project.status = project.status === 'active' ? 'stopped' : 'active';
      project.lastUpdate = new Date().toLocaleString();
      
      // 保存更新后的项目列表
      await fs.writeFile(projectsPath, JSON.stringify(projects, null, 2));
      
      // 根据状态启动或停止监控
      if (project.status === 'active') {
        // 启动监控
        await startMonitoringTask(project);
      } else {
        // 停止监控
        await stopMonitoringTask(projectId);
      }
      
      res.json({ 
        success: true, 
        project 
      });
    } catch (error) {
      logger.error(`切换项目状态错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 删除项目API
  app.delete('/api/projects/:id', async (req, res) => {
    try {
      const projectId = req.params.id;
      const projectsPath = path.join(appRoot, 'projects.json');
      
      if (!existsSync(projectsPath)) {
        return res.status(404).json({ 
          success: false, 
          error: '项目列表不存在' 
        });
      }
      
      // 读取项目列表
      const projectsData = await fs.readFile(projectsPath, 'utf8');
      const projects = JSON.parse(projectsData);
      
      // 查找项目
      const projectIndex = projects.findIndex(p => p.id === projectId);
      if (projectIndex === -1) {
        return res.status(404).json({ 
          success: false, 
          error: '找不到指定项目' 
        });
      }
      
      // 如果项目正在监控中，先停止监控
      const project = projects[projectIndex];
      if (project.status === 'active') {
        // 停止监控
        await stopMonitoringTask(projectId);
        logger.info(`已停止并删除项目 "${project.name}" 的监控`);
      }
      
      // 删除项目
      projects.splice(projectIndex, 1);
      
      // 保存更新后的项目列表
      await fs.writeFile(projectsPath, JSON.stringify(projects, null, 2));
      
      res.json({ 
        success: true 
      });
    } catch (error) {
      logger.error(`删除项目错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 配置页面
  app.get('/config', (req, res) => {
    const config = {
      githubToken: process.env.GITHUB_TOKEN || '',
      githubUsername: process.env.GITHUB_USERNAME || '',
      githubRepo: process.env.GITHUB_REPO || '',
      watchPath: process.env.WATCH_PATH || '',
      githubBranch: process.env.GITHUB_BRANCH || 'main',
      commitMessage: process.env.COMMIT_MESSAGE || 'Auto-commit: 文件更新',
      ignoredPatterns: process.env.IGNORED_PATTERNS || 'node_modules,.git,*.tmp',
      debounceTime: process.env.DEBOUNCE_TIME || '2000',
      logLevel: process.env.LOG_LEVEL || 'info'
    };

    res.render('config', {
      title: '配置',
      activePage: 'config',
      config,
      saved: false
    });
  });

  // 保存配置
  app.post('/config', async (req, res) => {
    try {
      const {
        githubToken,
        githubUsername,
        githubRepo,
        watchPath,
        githubBranch,
        commitMessage,
        ignoredPatterns,
        debounceTime,
        logLevel
      } = req.body;

      // 构建新的环境变量内容
      const envContent = `# GitHub 配置
GITHUB_TOKEN=${githubToken || ''}
GITHUB_USERNAME=${githubUsername || ''}
GITHUB_REPO=${githubRepo || ''}
GITHUB_BRANCH=${githubBranch || 'main'}

# 要监控的路径
WATCH_PATH=${watchPath || ''}

# 自动提交消息
COMMIT_MESSAGE=${commitMessage || 'Auto-commit: 文件更新'}

# 忽略的文件/文件夹模式（逗号分隔）
IGNORED_PATTERNS=${ignoredPatterns || 'node_modules,.git,*.tmp'}

# 防抖时间（毫秒）
DEBOUNCE_TIME=${debounceTime || '2000'}

# 日志级别 (error, warn, info, verbose, debug, silly)
LOG_LEVEL=${logLevel || 'info'}

# 服务器端口
PORT=3000`;

      // 保存到 .env 文件
      const envPath = path.join(appRoot, '.env');
      await fs.writeFile(envPath, envContent);

      // 更新当前进程的环境变量
      process.env.GITHUB_TOKEN = githubToken || '';
      process.env.GITHUB_USERNAME = githubUsername || '';
      process.env.GITHUB_REPO = githubRepo || '';
      process.env.WATCH_PATH = watchPath || '';
      process.env.GITHUB_BRANCH = githubBranch || 'main';
      process.env.COMMIT_MESSAGE = commitMessage || 'Auto-commit: 文件更新';
      process.env.IGNORED_PATTERNS = ignoredPatterns || 'node_modules,.git,*.tmp';
      process.env.DEBOUNCE_TIME = debounceTime || '2000';
      process.env.LOG_LEVEL = logLevel || 'info';

      logger.info('配置已保存并更新');

      // 验证新配置
      const validation = ConfigValidator.validateEnvironmentConfig();
      if (!validation.isValid) {
        logger.warn('保存的配置存在问题:');
        validation.errors.forEach(error => logger.warn(`- ${error}`));
      }

      // 重新渲染页面，显示保存成功消息
      const config = {
        githubToken: githubToken || '',
        githubUsername: githubUsername || '',
        githubRepo: githubRepo || '',
        watchPath: watchPath || '',
        githubBranch: githubBranch || 'main',
        commitMessage: commitMessage || 'Auto-commit: 文件更新',
        ignoredPatterns: ignoredPatterns || 'node_modules,.git,*.tmp',
        debounceTime: debounceTime || '2000',
        logLevel: logLevel || 'info'
      };

      res.render('config', {
        title: '配置',
        activePage: 'config',
        config,
        saved: true,
        validation
      });

    } catch (error) {
      logger.error(`保存配置失败: ${error.message}`);
      res.status(500).render('config', {
        title: '配置',
        activePage: 'config',
        config: req.body,
        saved: false,
        error: '保存配置失败: ' + error.message
      });
    }
  });

  // 性能监控页面
  app.get('/performance', (req, res) => {
    res.render('performance', {
      title: '性能监控',
      activePage: 'performance'
    });
  });

  // 测试页面
  app.get('/test', async (req, res) => {
    try {
      // 获取环境变量信息
      const config = {
        githubToken: process.env.GITHUB_TOKEN || '',
        githubUsername: process.env.GITHUB_USERNAME || '',
        githubRepo: process.env.GITHUB_REPO || '',
        isConfigured: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_USERNAME)
      };
      
      // 获取项目列表
      let projects = [];
      try {
        const projectsPath = path.join(appRoot, 'projects.json');
        if (existsSync(projectsPath)) {
          const projectsData = await fs.readFile(projectsPath, 'utf8');
          projects = JSON.parse(projectsData);
        }
        } catch (error) {
        logger.error(`读取项目列表错误: ${error.message}`);
      }
      
      res.render('test', { 
        config, 
        monitoringTasks: projects 
      });
    } catch (error) {
      logger.error(`渲染测试页面错误: ${error.message}`);
      res.status(500).send('服务器错误');
    }
  });
  
  // 获取 Token 的 API（用于测试页面）
  app.get('/api/config/token', (req, res) => {
    const token = process.env.GITHUB_TOKEN || '';
    res.json({ 
      success: true, 
      token 
    });
  });
  
  // 获取系统信息
  app.get('/system-info', (req, res) => {
    try {
      const systemInfo = getSystemInfo();
      res.json(systemInfo);
    } catch (error) {
      logger.error(`获取系统信息错误: ${error.message}`);
      res.status(500).json({ error: '获取系统信息失败' });
    }
  });
  
  // 文件浏览器页面
  app.get('/files', async (req, res) => {
    try {
      // 获取系统信息
      const systemInfo = getSystemInfo();
      
      // 如果没有指定路径，显示系统根目录选择页面
      if (!req.query.path) {
        const roots = getSystemRoots(systemInfo.platform);
        
        return res.render('files-home', {
          systemInfo,
          roots,
          currentPath: null,
          parentPath: null,
          items: []
        });
      }
      
      const currentPath = req.query.path;
      logger.info(`请求浏览文件路径: ${currentPath}`);
      
      // 检查路径是否存在
      let pathExists = false;
      try {
        pathExists = fs_sync.existsSync(currentPath);
      } catch (existsError) {
        logger.error(`检查路径是否存在时出错: ${existsError.message}`);
        return res.status(500).render('error', {
          title: '路径检查错误',
          message: `检查路径是否存在时出错: ${existsError.message}`,
          error: {
            status: 500,
            stack: process.env.NODE_ENV === 'development' ? existsError.stack : ''
          },
          systemInfo
        });
      }
      
      if (!pathExists) {
        logger.warn(`请求访问不存在的路径: ${currentPath}`);
        return res.status(404).render('error', {
          title: '路径不存在',
          message: `路径 ${currentPath} 不存在。`,
          error: {
            status: 404,
            stack: ''
          },
          systemInfo
        });
      }
      
      // 获取父目录
      let parentPath;
      try {
        parentPath = path.dirname(currentPath);
        // 确保父目录与当前目录不同（针对根目录的情况）
        if (parentPath === currentPath) {
          parentPath = null;
        }
      } catch (pathError) {
        logger.error(`获取父目录错误: ${pathError.message}`);
        parentPath = null;
      }
      
      // 检查是否是目录
      let isDirectory = false;
      try {
        const stats = fs_sync.statSync(currentPath);
        isDirectory = stats.isDirectory();
      } catch (statError) {
        logger.error(`获取路径状态信息出错: ${statError.message}`);
        return res.status(500).render('error', {
          title: '路径状态错误',
          message: `获取路径状态信息出错: ${statError.message}`,
          error: {
            status: 500,
            stack: process.env.NODE_ENV === 'development' ? statError.stack : ''
          },
          systemInfo
        });
      }
      
      if (!isDirectory) {
        logger.warn(`请求的路径不是目录: ${currentPath}`);
        return res.status(400).render('error', {
          title: '不是目录',
          message: `路径 ${currentPath} 不是一个目录。`,
          error: {
            status: 400,
            stack: ''
          },
          systemInfo
        });
      }
      
      // 获取目录内容
      let items = [];
      try {
        // 修复：确保路径使用正确的分隔符
        const normalizedPath = currentPath.replace(/\\/g, path.sep);
        items = await fs.readdir(normalizedPath, { withFileTypes: true });
      } catch (error) {
        logger.error(`读取目录内容错误 (${currentPath}): ${error.message}`);
        
        // 提供更友好的错误信息
        let errorMessage = `无法读取目录内容: ${error.message}`;
        let errorStatus = 500;
        
        // 检查是否是权限问题
        if (error.code === 'EACCES') {
          errorMessage = `权限不足，无法访问目录 ${currentPath}。在 Linux 系统中，某些系统目录需要 root 权限才能访问。`;
          errorStatus = 403;
        } else if (error.code === 'ENOENT') {
          errorMessage = `目录 ${currentPath} 不存在。`;
          errorStatus = 404;
        } else if (error.code === 'ENOTDIR') {
          errorMessage = `路径 ${currentPath} 不是一个目录。`;
          errorStatus = 400;
        }
        
        return res.status(errorStatus).render('error', {
          title: '目录访问错误',
          message: errorMessage,
          error: {
            status: errorStatus,
            stack: process.env.NODE_ENV === 'development' ? error.stack : ''
          },
          systemInfo
        });
      }
      
      // 处理目录项
      const directories = [];
      const files = [];
      
      // 已知的系统保留文件，不应尝试访问
      const systemReservedFiles = [
        'hiberfil.sys',
        'pagefile.sys',
        'swapfile.sys',
        'System Volume Information',
        '$Recycle.Bin',
        'Config.Msi'
      ];
      
      for (const item of items) {
        try {
          const itemPath = path.join(currentPath, item.name);
          
          // 跳过已知的系统保留文件
          if (systemReservedFiles.includes(item.name)) {
            files.push({
              name: item.name,
              path: itemPath,
              size: -1,
              isDirectory: false,
              restricted: true
            });
            continue;
          }
          
          // 检查文件是否存在和可访问
          let itemExists = false;
          try {
            itemExists = fs_sync.existsSync(itemPath);
          } catch (itemExistsError) {
            logger.warn(`检查项目是否存在时出错: ${itemPath}, ${itemExistsError.message}`);
            continue;
          }
          
          if (!itemExists) {
            logger.warn(`跳过不存在的项目: ${itemPath}`);
            continue;
          }
          
          if (item.isDirectory()) {
            directories.push({
              name: item.name,
              path: itemPath,
              isDirectory: true
            });
          } else {
            // 尝试获取文件状态
            try {
              const stats = await fs.stat(itemPath);
              files.push({
                name: item.name,
                path: itemPath,
                size: stats.size,
                isDirectory: false
              });
            } catch (fileError) {
              // 如果无法访问文件（如系统文件），则标记为受限
              logger.warn(`无法访问文件 ${itemPath}: ${fileError.message}`);
              files.push({
                name: item.name,
                path: itemPath,
                size: -1, // 标记为无法访问
                isDirectory: false,
                restricted: true
              });
            }
          }
        } catch (itemError) {
          // 跳过无法处理的项目
          logger.warn(`跳过项目处理错误: ${item ? item.name : 'unknown'}, ${itemError.message}`);
        }
      }
      
      // 按名称排序
      directories.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));
      
      res.render('files', {
        currentPath,
        parentPath,
        items: [...directories, ...files],
        systemInfo
      });
    } catch (error) {
      logger.error(`文件浏览器错误: ${error.message}`);
      logger.error(`错误堆栈: ${error.stack}`);
      
      // 尝试获取系统信息，如果失败则提供空对象
      let systemInfo;
      try {
        systemInfo = getSystemInfo();
      } catch (infoError) {
        logger.error(`获取系统信息失败: ${infoError.message}`);
        systemInfo = {};
      }
      
      res.status(500).render('error', {
        title: '服务器错误',
        message: `浏览文件时发生错误: ${error.message}`,
        error: {
          status: 500,
          stack: process.env.NODE_ENV === 'development' ? error.stack : ''
        },
        systemInfo
      });
    }
  });
  
  // 仓库页面
  app.get('/repos', async (req, res) => {
    try {
      // 重新加载环境变量，确保获取最新值
      dotenv.config();
      
      const githubToken = process.env.GITHUB_TOKEN;
      const githubUsername = process.env.GITHUB_USERNAME;
      
      // 获取查询参数
      const page = parseInt(req.query.page) || 1;
      const perPage = parseInt(req.query.perPage) || 100;
      const search = req.query.search || '';
      const autoSave = req.query.autoSave === 'true';
      
      logger.info(`仓库页面请求 - 环境变量检查:`);
      logger.info(`GITHUB_TOKEN: ${githubToken ? '已设置 (长度:' + githubToken.length + ')' : '未设置'}`);
      logger.info(`GITHUB_USERNAME: ${githubUsername || '未设置'}`);
      logger.info(`页码: ${page}, 每页数量: ${perPage}, 搜索关键词: ${search || '无'}`);
      
      // 本地仓库信息文件路径
      const reposInfoPath = path.join(appRoot, 'repos-info.json');
      
      // 读取已保存的仓库信息
      let savedRepos = [];
      try {
        if (existsSync(reposInfoPath)) {
          try {
            const reposInfoData = await fs.readFile(reposInfoPath, 'utf8');
            savedRepos = JSON.parse(reposInfoData);
            logger.info(`已从文件加载 ${savedRepos.length} 个保存的仓库信息`);
            
            // 如果有搜索关键词，过滤已保存的仓库
            if (search) {
              const searchLower = search.toLowerCase();
              savedRepos = savedRepos.filter(repo => 
                repo.name.toLowerCase().includes(searchLower) || 
                (repo.description && repo.description.toLowerCase().includes(searchLower))
              );
              logger.info(`搜索过滤后，已保存的仓库数量: ${savedRepos.length}`);
            }
          } catch (readError) {
            logger.error(`读取仓库信息文件错误: ${readError.message}`);
            // 不要抛出异常，继续处理
          }
        } else {
          logger.info(`仓库信息文件不存在，将创建新文件: ${reposInfoPath}`);
          try {
            // 创建空的仓库信息文件
            await fs.writeFile(reposInfoPath, '[]');
          } catch (createError) {
            logger.error(`创建仓库信息文件失败: ${createError.message}`);
            // 不要抛出异常，继续处理
          }
        }
      } catch (fileError) {
        logger.error(`处理仓库信息文件时出错: ${fileError.message}`);
        // 不要抛出异常，继续处理
      }
      
      // 从GitHub获取仓库列表
      let repos = [];
      let hasMorePages = false;
      let error = null;
      
      // 只有在设置了GitHub凭据时才尝试获取仓库列表
      if (githubToken && githubUsername) {
        try {
          // 创建GitHub API服务实例（不需要指定仓库和分支）
          const githubService = new GitHubApiService(githubToken, githubUsername, '');
          
          try {
            // 验证token有效性
            const isTokenValid = await githubService.validateToken();
            if (!isTokenValid) {
              throw new Error('GitHub Token无效或与用户名不匹配');
            }
            
            // 获取仓库列表
            repos = await githubService.getUserRepos(page, perPage);
            logger.info(`从GitHub获取了 ${repos.length} 个仓库`);
            
            // 如果返回的仓库数量等于每页数量，可能有更多页
            hasMorePages = repos.length === perPage;
            
            // 如果有搜索关键词，过滤仓库
            if (search) {
              const searchLower = search.toLowerCase();
              repos = repos.filter(repo => 
                repo.name.toLowerCase().includes(searchLower) || 
                (repo.description && repo.description.toLowerCase().includes(searchLower))
              );
              logger.info(`搜索过滤后，从GitHub获取的仓库数量: ${repos.length}`);
            }
            
            // 如果启用了自动保存，将获取的仓库信息保存到本地
            if (autoSave) {
              try {
                // 合并现有保存的仓库和新获取的仓库，避免重复
                const existingRepoIds = new Set(savedRepos.map(r => r.id));
                const newRepos = repos.filter(r => !existingRepoIds.has(r.id));
                
                if (newRepos.length > 0) {
                  const updatedSavedRepos = [...savedRepos, ...newRepos];
                  await fs.writeFile(reposInfoPath, JSON.stringify(updatedSavedRepos, null, 2));
                  logger.info(`已保存 ${newRepos.length} 个新仓库信息到本地`);
                  
                  // 更新savedRepos以在响应中反映新保存的仓库
                  savedRepos = updatedSavedRepos;
                }
              } catch (saveError) {
                logger.error(`保存仓库信息到本地失败: ${saveError.message}`);
                // 不要抛出异常，继续处理
              }
            }
          } catch (apiError) {
            logger.error(`GitHub API调用失败: ${apiError.message}`);
            error = `GitHub API调用失败: ${apiError.message}`;
            // 不要抛出异常，继续处理
          }
        } catch (githubError) {
          logger.error(`获取GitHub仓库列表失败: ${githubError.message}`);
          error = `获取GitHub仓库列表失败: ${githubError.message}`;
          // 不要抛出异常，继续处理
        }
      } else {
        logger.warn('未设置GitHub凭据，无法获取仓库列表');
        error = '未设置GitHub凭据，无法获取仓库列表。请在设置页面配置GitHub Token和用户名。';
      }
      
      // 确保在渲染页面前所有数据都是有效的
      if (!Array.isArray(savedRepos)) {
        logger.error('savedRepos不是数组，重置为空数组');
        savedRepos = [];
      }
      
      if (!Array.isArray(repos)) {
        logger.error('repos不是数组，重置为空数组');
        repos = [];
      }
      
      // 渲染页面
      return res.render('repos', { 
        savedRepos,
        repos,
        page,
        perPage,
        search,
        autoSave,
        error,
        pagination: {
          page,
          perPage,
          totalRepos: savedRepos.length,
          hasMorePages
        }
      });
    } catch (error) {
      logger.error(`仓库页面错误: ${error.message}`);
      logger.error(`错误堆栈: ${error.stack}`);
      
      // 尝试以最简单的方式渲染错误页面
      try {
        return res.status(500).render('error', {
          title: '服务器错误',
          message: `获取仓库列表时发生错误: ${error.message}`,
          error: {
            status: 500,
            stack: process.env.NODE_ENV === 'development' ? error.stack : ''
          },
          systemInfo: getSystemInfo()
        });
      } catch (renderError) {
        // 如果渲染错误页面也失败，返回最简单的错误响应
        logger.error(`渲染错误页面失败: ${renderError.message}`);
        return res.status(500).send(`
          <html>
            <head><title>内部服务器错误</title></head>
            <body>
              <h1>内部服务器错误</h1>
              <p>获取仓库列表时发生错误: ${error.message}</p>
              <p>渲染错误页面也失败: ${renderError.message}</p>
              <p><a href="/">返回首页</a></p>
            </body>
          </html>
        `);
      }
    }
  });
  
  // 删除仓库信息
  app.post('/delete-repo-info', async (req, res) => {
    // ... existing code ...
  });
  
  // 创建项目文件API
  app.post('/api/projects/:id/files', async (req, res) => {
    try {
      const projectId = req.params.id;
      const { fileName, fileContent } = req.body;
      
      if (!fileName) {
        return res.status(400).json({ 
          success: false, 
          error: '文件名不能为空' 
        });
      }
      
      // 获取项目信息
      const projectsPath = path.join(appRoot, 'projects.json');
      
      if (!existsSync(projectsPath)) {
        return res.status(404).json({ 
          success: false, 
          error: '项目列表不存在' 
        });
      }
      
      // 读取项目列表
      const projectsData = await fs.readFile(projectsPath, 'utf8');
      const projects = JSON.parse(projectsData);
      
      // 查找项目
      const project = projects.find(p => p.id === projectId);
      if (!project) {
        return res.status(404).json({ 
          success: false, 
          error: '找不到指定项目' 
        });
      }
      
      // 获取环境变量
      const githubToken = process.env.GITHUB_TOKEN;
      const githubUsername = process.env.GITHUB_USERNAME;
      
      if (!githubToken || !githubUsername) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少 GitHub Token 或用户名' 
        });
      }
      
      // 创建完整的文件路径
      const filePath = path.join(project.path, fileName);
      const dirPath = path.dirname(filePath);
      
      // 确保目录存在
      try {
        await fs.mkdir(dirPath, { recursive: true });
      } catch (mkdirError) {
        logger.error(`创建目录失败: ${mkdirError.message}`);
        return res.status(500).json({ 
          success: false, 
          error: `创建目录失败: ${mkdirError.message}` 
        });
      }
      
      // 写入文件内容
      try {
        await fs.writeFile(filePath, fileContent || '');
        logger.info(`文件 ${filePath} 已创建`);
      } catch (writeError) {
        logger.error(`写入文件失败: ${writeError.message}`);
        return res.status(500).json({ 
          success: false, 
          error: `写入文件失败: ${writeError.message}` 
        });
      }
      
      // 初始化 GitHub API 服务
      const githubService = new GitHubApiService(
        githubToken,
        githubUsername,
        project.repo,
        project.branch
      );
      
      // 上传文件到 GitHub
      try {
        const repoFilePath = getRelativePath(filePath, project.path);
        await githubService.uploadFile(filePath, repoFilePath, `添加文件: ${fileName}`);
        
        // 更新项目的最后更新时间
        await updateProjectLastUpdateTime(projectId);
        
        logger.info(`文件 ${fileName} 已上传到 GitHub`);
        
        res.json({ 
          success: true, 
          fileName,
          filePath
        });
      } catch (uploadError) {
        logger.error(`上传文件到 GitHub 失败: ${uploadError.message}`);
        return res.status(500).json({ 
          success: false, 
          error: `上传文件到 GitHub 失败: ${uploadError.message}` 
        });
      }
    } catch (error) {
      logger.error(`创建文件错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // 启动服务器
  app.listen(port, '0.0.0.0', () => {
    logger.info(`服务器已启动，正在监听端口 ${port}`);
    logger.info(`访问 http://localhost:${port} 进入管理界面`);

    // 启动所有活跃项目的监控
    startAllActiveProjects();
  });
  
  // 获取仓库分支API
  app.get('/api/repos/:owner/:repo/branches', async (req, res) => {
    try {
      const { owner, repo } = req.params;
      
      logger.info(`获取仓库分支请求: owner=${owner}, repo=${repo}`);
      
      // 获取GitHub凭据
      const githubToken = process.env.GITHUB_TOKEN;
      const githubUsername = process.env.GITHUB_USERNAME;
      
      if (!githubToken || !githubUsername) {
        logger.warn('未设置GitHub凭据，无法获取分支信息');
        return res.status(400).json({
          success: false,
          error: '未设置GitHub凭据，无法获取分支信息'
        });
      }
      
      try {
        // 创建GitHub API服务实例
        const githubService = new GitHubApiService(githubToken, githubUsername, repo);
        
        // 验证token有效性
        const isTokenValid = await githubService.validateToken();
        if (!isTokenValid) {
          logger.error('GitHub Token无效或与用户名不匹配');
          return res.status(401).json({
            success: false,
            error: 'GitHub Token无效或与用户名不匹配'
          });
        }
        
        // 获取分支列表
        const branches = await githubService.getRepoBranches(repo);
        logger.info(`成功获取仓库 ${repo} 的分支列表，共 ${branches.length} 个分支`);
        
        return res.json({
          success: true,
          data: branches
        });
      } catch (apiError) {
        logger.error(`GitHub API调用失败: ${apiError.message}`);
        
        // 检查特定的错误类型
        if (apiError.response) {
          const status = apiError.response.status;
          const message = apiError.response.data && apiError.response.data.message 
            ? apiError.response.data.message 
            : apiError.message;
          
          if (status === 404) {
            logger.error(`仓库 ${repo} 不存在或无权访问`);
            return res.status(404).json({
              success: false,
              error: `仓库 ${repo} 不存在或无权访问`,
              details: message
            });
          }
          
          return res.status(status).json({
            success: false,
            error: `GitHub API错误: ${message}`,
            status
          });
        }
        
        return res.status(500).json({
          success: false,
          error: `获取仓库分支失败: ${apiError.message}`
        });
      }
    } catch (error) {
      logger.error(`获取仓库分支失败: ${error.message}`);
      logger.error(`错误堆栈: ${error.stack}`);
      
      return res.status(500).json({
        success: false,
        error: `获取仓库分支失败: ${error.message}`
      });
    }
  });
  
  // GitHub连接测试API
  app.get('/api/github-test', async (req, res) => {
    try {
      // 获取环境变量
      const githubToken = process.env.GITHUB_TOKEN;
      const githubUsername = process.env.GITHUB_USERNAME;
      const testRepo = req.query.repo || 'test';
      
      if (!githubToken || !githubUsername) {
        return res.status(400).json({ 
          success: false, 
          error: '缺少 GitHub Token 或用户名',
          config: {
            hasToken: !!githubToken,
            hasUsername: !!githubUsername
          }
        });
      }
      
      // 初始化 GitHub API 服务
      const githubService = new GitHubApiService(
        githubToken,
        githubUsername,
        testRepo,
        'main'
      );
      
      // 验证 token 有效性
      const isTokenValid = await githubService.validateToken();
      
      if (!isTokenValid) {
        return res.json({ 
          success: false, 
          error: 'GitHub Token 无效或与用户名不匹配',
          token: githubToken.substring(0, 5) + '...',
          username: githubUsername
        });
      }
      
      // 尝试创建一个测试文件
      const testContent = `测试文件 - ${new Date().toISOString()}`;
      const testFileName = 'test-file.txt';
      
      // 创建临时文件
      const tempFilePath = path.join(appRoot, 'temp', testFileName);
      
      // 确保临时目录存在
      await fs.mkdir(path.join(appRoot, 'temp'), { recursive: true });
      
      // 写入测试内容
      await fs.writeFile(tempFilePath, testContent);
      
      try {
        // 上传测试文件
        const uploadResult = await githubService.uploadFile(
          tempFilePath,
          testFileName,
          '测试上传'
        );
        
        // 删除临时文件
        await fs.unlink(tempFilePath);
        
        return res.json({
          success: true,
          message: 'GitHub 连接测试成功',
          token: githubToken.substring(0, 5) + '...',
          username: githubUsername,
          repo: testRepo,
          uploadResult: {
            success: true,
            url: uploadResult.content.html_url
          }
        });
      } catch (uploadError) {
        // 删除临时文件
        try {
          await fs.unlink(tempFilePath);
        } catch (unlinkError) {
          logger.error(`删除临时文件错误: ${unlinkError.message}`);
        }
        
        return res.json({
          success: false,
          message: 'GitHub 连接成功，但上传测试失败',
          token: githubToken.substring(0, 5) + '...',
          username: githubUsername,
          repo: testRepo,
          error: uploadError.message,
          fullError: uploadError.toString(),
          response: uploadError.response ? {
            status: uploadError.response.status,
            statusText: uploadError.response.statusText,
            data: uploadError.response.data
          } : null
        });
      }
    } catch (error) {
      logger.error(`GitHub 连接测试错误: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message,
        fullError: error.toString()
      });
    }
  });
  
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(3000);
} 