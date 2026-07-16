/**
 * migration/operationGate — campaign staging 与执行窗口的进程内互斥门。
 *
 * campaign 可包含下载/状态降级/重 stage 等 await；执行窗口必须等当前
 * campaign 完整收敛后才能读取 marker。反向地，执行期间新 campaign 直接
 * 跳过，由下一轮 manifest 轮询重试，避免安装中途改写 marker。
 */

/** campaign / execution 两类迁移操作的轻量单进程互斥器。 */
export class MigrationOperationGate {
  private campaignDone: Promise<void> | null = null;
  private executionActive = false;

  get isCampaignActive(): boolean {
    return this.campaignDone != null;
  }

  get isExecutionActive(): boolean {
    return this.executionActive;
  }

  /** 尝试进入 campaign；已有 campaign 或执行窗口时返回 null。 */
  tryStartCampaign(): (() => void) | null {
    if (this.campaignDone != null || this.executionActive) return null;
    let resolveDone!: () => void;
    this.campaignDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.campaignDone = null;
      resolveDone();
    };
  }

  /** 等待当前 campaign 收敛后进入执行窗口；成功时返回幂等 release。 */
  async tryStartExecution(): Promise<(() => void) | null> {
    // release 会先清旧 Promise 再 resolve；若等待期间新 campaign 抢先进入，
    // 循环会继续等待新的 Promise，不会穿透到它的中间状态。
    while (this.campaignDone != null) {
      await this.campaignDone;
    }
    if (this.executionActive) return null;
    this.executionActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.executionActive = false;
    };
  }
}
