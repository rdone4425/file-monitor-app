import axios from 'axios';
import fs from 'fs/promises';
import fs_sync from 'fs';
import path from 'path';
import FormData from 'form-data';
import mime from 'mime-types';
import { logger } from './logger.js';
import { RetryHandler, ErrorClassifier } from './retry-handler.js';

/**
 * GitHub API 服务类
 */
export class GitHubApiService {
  /**
   * 构造函数
   * @param {string} token - GitHub 个人访问令牌
   * @param {string} username - GitHub 用户名
   * @param {string} repo - 仓库名称
   * @param {string} branch - 分支名称
   */
  constructor(token, username, repo, branch = 'main') {
    this.token = token;
    this.username = username;
    this.repo = repo;
    this.branch = branch;
    this.baseUrl = 'https://api.github.com';
    this.headers = {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /**
   * 验证 token 有效性
   * @returns {Promise<boolean>} - token 是否有效
   */
  async validateToken() {
    try {
      const response = await RetryHandler.executeWithRetry(
        () => axios.get(`${this.baseUrl}/user`, { headers: this.headers }),
        {
          maxRetries: 2,
          baseDelay: 1000,
          retryCondition: RetryHandler.githubRetryCondition
        }
      );

      logger.info(`Token 验证成功，用户: ${response.data.login}`);

      // 验证是否与提供的用户名匹配
      if (response.data.login !== this.username) {
        logger.warn(`Token 所属用户 (${response.data.login}) 与提供的用户名 (${this.username}) 不匹配`);
        return false;
      }

      return true;
    } catch (error) {
      const errorReport = ErrorClassifier.generateReport(error);
      logger.error(`Token 验证失败:\n${errorReport}`);
      return false;
    }
  }

  /**
   * 获取仓库的最新提交 SHA
   * @returns {Promise<string>} - 最新提交的 SHA
   */
  async getLatestCommitSha() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/repos/${this.username}/${this.repo}/git/refs/heads/${this.branch}`,
        { headers: this.headers }
      );
      return response.data.object.sha;
    } catch (error) {
      logger.error(`获取最新提交 SHA 失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取文件内容
   * @param {string} filePath - 文件路径
   * @returns {Promise<object>} - 文件内容和 SHA
   */
  async getFileContent(filePath) {
    try {
      const encodedPath = encodeURIComponent(filePath);
      const response = await axios.get(
        `${this.baseUrl}/repos/${this.username}/${this.repo}/contents/${encodedPath}?ref=${this.branch}`,
        { headers: this.headers }
      );
      return {
        content: Buffer.from(response.data.content, 'base64').toString('utf-8'),
        sha: response.data.sha
      };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return { content: null, sha: null };
      }
      logger.error(`获取文件内容失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建或更新文件
   * @param {string} localFilePath - 本地文件完整路径
   * @param {string} repoFilePath - 仓库中的文件路径
   * @param {string} message - 提交消息
   * @returns {Promise<object>} - 上传结果
   */
  async uploadFile(localFilePath, repoFilePath, message) {
    try {
      // 检查文件是否存在
      if (!fs_sync.existsSync(localFilePath)) {
        logger.error(`本地文件不存在: ${localFilePath}`);
        throw new Error(`文件不存在: ${localFilePath}`);
      }

      // 确保目标路径合法
      const normalizedRepoPath = repoFilePath.replace(/\\/g, '/');
      
      // 检查路径是否包含父目录
      const parentDir = path.dirname(normalizedRepoPath);
      if (parentDir !== '.' && parentDir !== '/') {
        logger.info(`文件 ${normalizedRepoPath} 包含父目录: ${parentDir}`);
      }

      // 使用重试机制执行上传
      const response = await RetryHandler.executeWithRetry(
        async () => {
          // 读取文件内容
          let content;
          try {
            content = await fs.readFile(localFilePath);
          } catch (readError) {
            logger.error(`读取文件失败: ${localFilePath}, 错误: ${readError.message}`);
            throw new Error(`无法读取文件: ${readError.message}`);
          }
          const base64Content = content.toString('base64');

          // 获取文件的当前 SHA（如果存在）
          const { sha } = await this.getFileContent(normalizedRepoPath);

          // 构建请求体
          const requestBody = {
            message,
            content: base64Content,
            branch: this.branch
          };

          // 如果文件已存在，添加 SHA
          if (sha) {
            requestBody.sha = sha;
          }

          // 发送请求
          return await axios.put(
            `${this.baseUrl}/repos/${this.username}/${this.repo}/contents/${encodeURIComponent(normalizedRepoPath)}`,
            requestBody,
            { headers: this.headers }
          );
        },
        {
          maxRetries: 3,
          baseDelay: 2000,
          retryCondition: RetryHandler.githubRetryCondition,
          onRetry: (error, attempt) => {
            logger.warn(`文件 ${repoFilePath} 上传重试 (第 ${attempt} 次): ${error.message}`);
          }
        }
      );

      logger.info(`文件 ${repoFilePath} 上传成功`);
      return response.data;
    } catch (error) {
      const errorReport = ErrorClassifier.generateReport(error);
      logger.error(`上传文件失败 ${repoFilePath}:\n${errorReport}`);
      throw error;
    }
  }

  /**
   * 删除文件
   * @param {string} filePath - 文件路径
   * @param {string} message - 提交消息
   * @returns {Promise<object>} - 删除结果
   */
  async deleteFile(filePath, message) {
    try {
      // 获取文件的当前 SHA
      const { sha } = await this.getFileContent(filePath);
      
      if (!sha) {
        logger.warn(`文件 ${filePath} 不存在，无法删除`);
        return null;
      }
      
      // 发送删除请求
      const response = await axios.delete(
        `${this.baseUrl}/repos/${this.username}/${this.repo}/contents/${encodeURIComponent(filePath)}`,
        {
          headers: this.headers,
          data: {
            message,
            sha,
            branch: this.branch
          }
        }
      );
      
      logger.info(`文件 ${filePath} 删除成功`);
      return response.data;
    } catch (error) {
      logger.error(`删除文件失败 ${filePath}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取用户的仓库列表
   * @param {number} page - 页码
   * @param {number} perPage - 每页数量
   * @returns {Promise<Array>} - 仓库列表
   */
  async getUserRepos(page = 1, perPage = 100) {
    try {
      const response = await RetryHandler.executeWithRetry(
        () => axios.get(`${this.baseUrl}/user/repos`, { 
          headers: this.headers,
          params: {
            page,
            per_page: perPage,
            sort: 'updated',
            direction: 'desc'
          }
        }),
        {
          maxRetries: 2,
          baseDelay: 1000,
          retryCondition: RetryHandler.githubRetryCondition
        }
      );

      logger.info(`成功获取用户仓库列表，共 ${response.data.length} 个仓库`);
      
      // 提取需要的仓库信息
      const repos = response.data.map(repo => ({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        description: repo.description,
        private: repo.private,
        html_url: repo.html_url,
        default_branch: repo.default_branch,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        branches_url: repo.branches_url.replace('{/branch}', ''),
        owner: {
          login: repo.owner.login,
          avatar_url: repo.owner.avatar_url
        }
      }));
      
      return repos;
    } catch (error) {
      const errorReport = ErrorClassifier.generateReport(error);
      logger.error(`获取用户仓库列表失败:\n${errorReport}`);
      throw error;
    }
  }
  
  /**
   * 获取仓库的分支列表
   * @param {string} repoName - 仓库名称
   * @returns {Promise<Array>} - 分支列表
   */
  async getRepoBranches(repoName) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/repos/${this.username}/${repoName}/branches`,
        { headers: this.headers }
      );
      
      logger.info(`成功获取仓库 ${repoName} 的分支列表，共 ${response.data.length} 个分支`);
      
      return response.data.map(branch => ({
        name: branch.name,
        commit: branch.commit.sha
      }));
    } catch (error) {
      logger.error(`获取仓库分支列表失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 上传多个文件
   * @param {Array<{localPath: string, repoPath: string}>} files - 文件列表
   * @param {string} message - 提交消息
   * @returns {Promise<Array>} - 上传结果
   */
  async uploadFiles(files, message) {
    const results = [];
    
    for (const file of files) {
      try {
        const result = await this.uploadFile(file.localPath, file.repoPath, message);
        results.push({ file, success: true, result });
      } catch (error) {
        results.push({ file, success: false, error: error.message });
      }
    }
    
    return results;
  }
} 