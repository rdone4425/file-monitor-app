import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from './logger.js';
import { GitHubApiService } from './github-api.js';
import dotenv from 'dotenv';
import axios from 'axios';
import os from 'os';
import { createWatcher } from './watcher.js';
import fs_sync from 'fs';

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
 * 获取文件相对路径
 * @param {string} filePath - 文件的完整路径
 * @param {string} basePath - 基础路径
 * @returns {string} - 相对路径
 */
function getRelativePath(filePath, basePath) {
  // 规范化路径
  const normalizedFilePath = path.normalize(filePath);
  const normalizedBasePath = path.normalize(basePath);
  
  // 获取相对路径
  let relativePath = path.relative(normalizedBasePath, normalizedFilePath);
  
  // 将反斜杠转换为正斜杠（在 Windows 上）
  relativePath = relativePath.replace(/\\/g, '/');
  
  return relativePath;
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
      stopMonitoringTask(project.id);
    }
    
    // 验证路径存在
    if (!existsSync(project.path)) {
      logger.error(`项目 "${project.name}" 的路径不存在: ${project.path}`);
      return false;
    }
    
    // 获取环境变量
    const githubToken = process.env.GITHUB_TOKEN;
    const githubUsername = process.env.GITHUB_USERNAME;
    
    if (!githubToken || !githubUsername) {
      logger.error(`项目 "${project.name}" 启动失败: 缺少 GitHub Token 或用户名`);
      return false;
    }
    
    // 忽略的文件/文件夹模式
    const ignoredPatterns = project.ignoredPatterns 
      ? project.ignoredPatterns.split(',') 
      : ['node_modules', '.git', '*.tmp'];
    
    // 配置延迟提交时间（毫秒）
    const debounceTime = 2000;
    
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
      logger.error(`项目 "${project.name}" 启动失败: GitHub Token 无效`);
      return false;
    }
    
    // 检查路径是文件还是目录
    const stats = await fs.stat(project.path);
    const isFile = stats.isFile();
    
    logger.info(`启动项目 "${project.name}" 的文件监控`);
    logger.info(`监控路径: ${project.path}`);
    logger.info(`GitHub 仓库: ${githubUsername}/${project.repo}`);
    logger.info(`GitHub 分支: ${project.branch}`);
    
    // 创建并启动文件监控
    const watcher = createWatcher(project.path, ignoredPatterns, debounceTime, async (changedFiles) => {
      try {
        logger.info(`项目 "${project.name}" 检测到文件变化: ${changedFiles.length} 个文件被修改`);
        
        if (changedFiles.length > 0) {
          // 准备上传文件
          const filesToUpload = changedFiles
            .filter(file => fs_sync.existsSync(file)) // 过滤掉已删除的文件
            .map(file => {
              // 如果监控的是单个文件，直接使用文件名作为仓库路径
              const repoPath = isFile ? path.basename(file) : getRelativePath(file, project.path);
              return {
                localPath: file,
                repoPath: repoPath
              };
            });
          
          // 上传文件
          if (filesToUpload.length > 0) {
            const uploadResults = await githubService.uploadFiles(filesToUpload, project.commitMessage);
            
            // 输出上传结果
            const successCount = uploadResults.filter(r => r.success).length;
            const failCount = uploadResults.length - successCount;
            
            logger.info(`项目 "${project.name}" 上传完成: ${successCount} 成功, ${failCount} 失败`);
            
            // 记录失败的文件
            if (failCount > 0) {
              uploadResults
                .filter(r => !r.success)
                .forEach(r => logger.error(`项目 "${project.name}" 文件 ${r.file.repoPath} 上传失败: ${r.error}`));
            }
          }
          
          // 处理已删除的文件
          const deletedFiles = changedFiles
            .filter(file => !fs_sync.existsSync(file))
            .map(file => isFile ? path.basename(file) : getRelativePath(file, project.path));
          
          if (deletedFiles.length > 0) {
            logger.info(`项目 "${project.name}" 处理已删除的文件: ${deletedFiles.length} 个`);
            
            for (const filePath of deletedFiles) {
              try {
                await githubService.deleteFile(filePath, `删除文件: ${filePath}`);
              } catch (error) {
                logger.error(`项目 "${project.name}" 删除远程文件 ${filePath} 失败: ${error.message}`);
              }
            }
          }
          
          // 更新项目的最后更新时间
          await updateProjectLastUpdateTime(project.id);
        }
      } catch (error) {
        logger.error(`项目 "${project.name}" GitHub 操作失败: ${error.message}`);
      }
    });
    
    // 保存监控任务
    activeMonitoringTasks.set(project.id, {
      watcher,
      project
    });
    
    logger.info(`项目 "${project.name}" 监控已启动，等待文件变化...`);
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
function stopMonitoringTask(projectId) {
  try {
    if (!activeMonitoringTasks.has(projectId)) {
      logger.warn(`找不到项目ID为 ${projectId} 的监控任务`);
      return false;
    }
    
    const { watcher, project } = activeMonitoringTasks.get(projectId);
    
    // 关闭监控
    watcher.close();
    
    // 从活跃任务中移除
    activeMonitoringTasks.delete(projectId);
    
    logger.info(`项目 "${project.name}" 的监控已停止`);
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
    
    // 验证路径存在
    if (!existsSync(project.path)) {
      logger.error(`项目 "${project.name}" 的路径不存在: ${project.path}`);
      return false;
    }
    
    // 获取环境变量
    const githubToken = process.env.GITHUB_TOKEN;
    const githubUsername = process.env.GITHUB_USERNAME;
    
    if (!githubToken || !githubUsername) {
      logger.error(`项目 "${project.name}" 初始上传失败: 缺少 GitHub Token 或用户名`);
      return false;
    }
    
    // 忽略的文件/文件夹模式
    const ignoredPatterns = project.ignoredPatterns 
      ? project.ignoredPatterns.split(',') 
      : ['node_modules', '.git', '*.tmp'];
    
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
      logger.error(`项目 "${project.name}" 初始上传失败: GitHub Token 无效`);
      return false;
    }
    
    try {
      // 检查路径是文件还是目录
      const stats = await fs.stat(project.path);
      
      if (stats.isFile()) {
        // 如果是单个文件，直接上传
        logger.info(`项目 "${project.name}" 路径是单个文件，准备上传...`);
        
        const fileName = path.basename(project.path);
        
        // 上传文件
        const result = await githubService.uploadFile(
          project.path,
          fileName,
          project.commitMessage || 'Initial commit'
        );
        
        logger.info(`项目 "${project.name}" 文件 ${fileName} 上传成功`);
        
        // 更新项目的最后更新时间
        await updateProjectLastUpdateTime(project.id);
        
        return true;
      } else if (stats.isDirectory()) {
        // 如果是目录，递归获取所有文件
        logger.info(`项目 "${project.name}" 路径是目录，准备扫描文件...`);
        
        // 递归获取所有文件
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
}

/**
 * 获取系统根目录
 * @param {string} platform - 操作系统平台
 * @returns {string} - 系统根目录
 */
function getSystemRoots(platform) {
  if (platform === 'win32') {
    // Windows系统，获取所有驱动器
    try {
      // 原来使用 wmic 命令的方法有问题，改用 Node.js path 模块
      // 常见的 Windows 驱动器盘符
      const possibleDrives = ['A:', 'B:', 'C:', 'D:', 'E:', 'F:', 'G:', 'H:', 'I:', 'J:', 'K:', 'L:', 'M:', 
                             'N:', 'O:', 'P:', 'Q:', 'R:', 'S:', 'T:', 'U:', 'V:', 'W:', 'X:', 'Y:', 'Z:'];
      
      // 检查哪些驱动器实际存在
      const drives = [];
      for (const drive of possibleDrives) {
        try {
          // 尝试检查驱动器是否存在
          if (existsSync(drive + '\\')) {
            drives.push(drive);
          }
        } catch (err) {
          // 忽略错误，继续检查其他驱动器
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
    return ['/'];
  }
}

export function startServer(port = 3000) {
  const app = express();
  
  // 设置模板引擎
  app.set('view engine', 'ejs');
  app.set('views', path.join(appRoot, 'views'));
  
  // 中间件设置
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());
  app.use(express.static(path.join(appRoot, 'public')));
  
  // 添加全局辅助函数
  app.use((req, res, next) => {
    res.locals.formatFileSize = formatFileSize;
    next();
  });
  
  // 仪表盘页面 - 获取项目列表
  app.get('/', async (req, res) => {
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
      
      // 使用 EJS 模板渲染页面
      res.render('dashboard-new', { 
        config, 
        monitoringTasks: projects 
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
        stopMonitoringTask(projectId);
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
        stopMonitoringTask(projectId);
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
    
    res.render('config', { config, saved: false });
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
      
      // 获取父目录
      let parentPath;
      try {
        parentPath = path.dirname(currentPath);
        // 确保父目录与当前目录不同（针对根目录的情况）
        if (parentPath === currentPath) {
          parentPath = null;
        }
      } catch (error) {
        logger.error(`获取父目录错误: ${error.message}`);
        parentPath = null;
      }
      
      // 获取目录内容
      let items = [];
      try {
        items = await fs.readdir(currentPath, { withFileTypes: true });
      } catch (error) {
        logger.error(`读取目录内容错误: ${error.message}`);
        return res.status(500).send(`无法读取目录内容: ${error.message}`);
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
        const itemPath = path.join(currentPath, item.name);
        
        try {
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
          logger.warn(`跳过项目 ${itemPath}: ${itemError.message}`);
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
      res.status(500).send(`浏览文件时发生错误: ${error.message}`);
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
        }
      }
      
      // 即使没有设置环境变量，也尝试获取仓库列表
      try {
        // 这里应该添加获取仓库列表的逻辑
        // 暂时只记录日志
        logger.info('即使没有设置环境变量，也尝试获取仓库列表');
    } catch (error) {
      logger.error(`获取仓库列表错误: ${error.message}`);
      }
      
      res.render('repos', { 
        savedRepos,
        repos: [], // 确保始终有一个空数组
        page,
        perPage,
        search,
        autoSave,
        error: null, // 添加 error 变量，设为 null
        pagination: {
          page,
          perPage,
          totalRepos: savedRepos.length,
          hasMorePages: false
        }
      });
    } catch (error) {
      logger.error(`仓库页面错误: ${error.message}`);
      res.render('repos', {
        savedRepos: [],
        repos: [], 
        page: 1,
        perPage: 100,
        search: '',
        autoSave: false,
        error: `获取仓库列表时发生错误: ${error.message}`,
        pagination: {
          page: 1,
          perPage: 100,
          totalRepos: 0,
          hasMorePages: false
        }
      });
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
  
  // 启动所有活跃项目的监控
  startAllActiveProjects().then(() => {
    logger.info('所有活跃项目的监控已启动');
  });
  
  // 启动服务器
  app.listen(port, () => {
    logger.info(`服务器已启动，监听端口: ${port}`);
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