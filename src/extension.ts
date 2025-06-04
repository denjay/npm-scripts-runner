import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// 状态栏按钮
let statusBarItem: vscode.StatusBarItem;
// 存储全局扩展上下文
let globalContext: vscode.ExtensionContext;
// 最后执行的脚本的存储键前缀
const LAST_EXECUTED_SCRIPT_KEY_PREFIX = "lastExecutedScript_";

/**
 * 清理过期的脚本历史记录
 */
async function cleanupScriptHistory() {
  if (!globalContext) {
    return;
  }

  const allKeys = globalContext.globalState.keys();
  const scriptKeys = allKeys.filter((key) =>
    key.startsWith(LAST_EXECUTED_SCRIPT_KEY_PREFIX)
  );

  // 获取所有打开的工作区路径
  const openWorkspacePaths =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [];

  // 删除已关闭工作区的记录
  for (const key of scriptKeys) {
    const workspacePath = key.substring(LAST_EXECUTED_SCRIPT_KEY_PREFIX.length);
    if (
      workspacePath !== "global" &&
      !openWorkspacePaths.includes(workspacePath)
    ) {
      await globalContext.globalState.update(key, undefined);
    }
  }
}

/**
 * 清理指定工作区的终端
 */
function cleanupTerminal(workspaceFolder: vscode.WorkspaceFolder) {
  const terminal = terminals.get(workspaceFolder.uri.fsPath);
  if (terminal) {
    terminal.dispose();
    terminals.delete(workspaceFolder.uri.fsPath);
  }
}

/**
 * 更新状态栏按钮的可见性
 */
function updateStatusBarVisibility() {
  if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
}

/**
 * 获取当前工作区路径
 * @returns 当前工作区路径或null
 */
function getCurrentWorkspacePath(): string | null {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return null;
  }
  return workspaceFolders[0].uri.fsPath;
}

/**
 * 获取项目的最后执行脚本的存储键
 * @param workspaceFolder 工作区文件夹
 * @returns 存储键
 */
function getLastExecutedScriptKey(
  workspaceFolder: vscode.WorkspaceFolder
): string {
  return LAST_EXECUTED_SCRIPT_KEY_PREFIX + workspaceFolder.uri.fsPath;
}

/**
 * 获取项目最后执行的脚本
 * @param workspaceFolder 工作区文件夹
 * @returns 最后执行的脚本名称
 */
function getLastExecutedScript(
  workspaceFolder: vscode.WorkspaceFolder
): string | undefined {
  if (!globalContext) {
    return undefined;
  }
  const key = getLastExecutedScriptKey(workspaceFolder);
  return globalContext.globalState.get<string>(key);
}

/**
 * 更新最后执行的脚本
 * @param workspaceFolder 工作区文件夹
 * @param scriptName 执行的脚本名称
 */
async function updateLastExecutedScript(
  workspaceFolder: vscode.WorkspaceFolder,
  scriptName: string
) {
  if (!globalContext) {
    return;
  }
  const key = getLastExecutedScriptKey(workspaceFolder);
  await globalContext.globalState.update(key, scriptName);
}

/**
 * 从package.json文件中读取scripts
 * @param workspaceFolder 工作区文件夹
 * @returns 包含所有npm脚本的对象和可能的错误信息
 */
async function getNpmScripts(workspaceFolder: vscode.WorkspaceFolder): Promise<{
  scripts: { [key: string]: string } | null;
  error?: string;
}> {
  try {
    const packageJsonPath = path.join(
      workspaceFolder.uri.fsPath,
      "package.json"
    );

    // 检查package.json是否存在
    if (!fs.existsSync(packageJsonPath)) {
      return {
        scripts: null,
        error: "No package.json found in the workspace",
      };
    }

    // 读取package.json文件
    const packageJsonContent = await fs.promises.readFile(
      packageJsonPath,
      "utf8"
    );

    let packageJson;
    try {
      packageJson = JSON.parse(packageJsonContent);
    } catch (parseError) {
      return {
        scripts: null,
        error: "Invalid package.json: JSON parse error",
      };
    }

    if (!packageJson.scripts || Object.keys(packageJson.scripts).length === 0) {
      return {
        scripts: null,
        error: "No scripts found in package.json",
      };
    }

    // 返回scripts对象
    return { scripts: packageJson.scripts };
  } catch (error) {
    console.error("Error reading package.json:", error);
    return {
      scripts: null,
      error: `Error reading package.json: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

// 存储每个工作区的终端
const terminals: Map<string, vscode.Terminal> = new Map();

/**
 * 获取或创建工作区的专用终端
 * @param workspaceFolder 工作区文件夹
 * @returns 终端实例
 */
function getOrCreateTerminal(
  workspaceFolder: vscode.WorkspaceFolder
): vscode.Terminal {
  const key = workspaceFolder.uri.fsPath;
  let terminal = terminals.get(key);

  // 检查终端是否仍然存在（可能被用户关闭）
  if (!terminal || !vscode.window.terminals.includes(terminal)) {
    terminal = vscode.window.createTerminal({
      name: `Run NPM Scripts (${workspaceFolder.name})`,
      cwd: workspaceFolder.uri.fsPath,
    });
    terminals.set(key, terminal);
  }

  return terminal;
}

/**
 * 显示npm脚本列表并执行选中的脚本
 */
async function showScriptsList() {
  // 获取所有工作区
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage("Please open a workspace first");
    return;
  }

  // 如果有多个工作区，让用户选择
  let selectedWorkspace = workspaceFolders[0];
  if (workspaceFolders.length > 1) {
    const selected = await vscode.window.showQuickPick(
      workspaceFolders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder: folder,
      })),
      {
        placeHolder: "Select a workspace to run npm scripts",
      }
    );
    if (!selected) {
      return;
    }
    selectedWorkspace = selected.folder;
  }

  // 获取npm脚本
  const { scripts, error } = await getNpmScripts(selectedWorkspace);
  if (error) {
    vscode.window.showErrorMessage(error);
    return;
  }

  if (!scripts) {
    return; // 错误已经在getNpmScripts中显示
  }

  // 获取最后执行的脚本
  const lastExecutedScript = getLastExecutedScript(selectedWorkspace);

  // 创建快速选择项
  let items = Object.entries(scripts).map(([name, command]) => ({
    label: name,
    description:
      name === lastExecutedScript ? `${command} (Last executed)` : command,
    sortOrder: name === lastExecutedScript ? 0 : 1,
  }));

  // 按最后执行的脚本排序
  items.sort((a, b) => a.sortOrder - b.sortOrder);

  // 显示快速选择列表
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select an npm script to run",
  });

  if (selected && globalContext) {
    // 获取或创建工作区专用终端
    const terminal = getOrCreateTerminal(selectedWorkspace);
    terminal.show();

    // 执行npm命令
    terminal.sendText(`npm run ${selected.label}`);

    // 更新最后执行的脚本
    await updateLastExecutedScript(selectedWorkspace, selected.label);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Run NPM Scripts extension is now active!");

  // 保存全局上下文
  globalContext = context;

  // 创建状态栏按钮
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.text = "$(run) npm scripts";
  statusBarItem.tooltip = "Click to show npm scripts";
  statusBarItem.command = "run-npm-scripts.showScripts";

  // 根据当前工作区状态设置按钮可见性
  updateStatusBarVisibility();

  // 注册命令
  let disposable = vscode.commands.registerCommand(
    "run-npm-scripts.showScripts",
    showScriptsList
  );

  // 监听终端关闭事件
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      // 找到并删除已关闭的终端
      for (const [key, value] of terminals.entries()) {
        if (value === terminal) {
          terminals.delete(key);
          break;
        }
      }
    })
  );

  // 监听工作区变化事件
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      // 清理已移除工作区的终端
      event.removed.forEach((folder) => {
        cleanupTerminal(folder);
      });

      // 更新状态栏按钮可见性
      updateStatusBarVisibility();

      // 清理脚本历史记录
      cleanupScriptHistory();
    })
  );

  // 定期清理脚本历史记录（每小时）
  const cleanupInterval = setInterval(() => {
    cleanupScriptHistory();
  }, 60 * 60 * 1000);

  // 确保清理间隔在扩展停用时被清除
  context.subscriptions.push({
    dispose: () => clearInterval(cleanupInterval),
  });

  context.subscriptions.push(disposable, statusBarItem);
}

export function deactivate() {
  // 清理状态栏按钮
  if (statusBarItem) {
    statusBarItem.dispose();
  }

  // 清理所有终端
  for (const terminal of terminals.values()) {
    terminal.dispose();
  }
  terminals.clear();

  // 清理过期的脚本历史记录
  cleanupScriptHistory().catch((error) => {
    console.error("Error cleaning up script history:", error);
  });
}
