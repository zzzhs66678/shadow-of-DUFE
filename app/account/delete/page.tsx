import type { Metadata } from "next";
import { LegalPage } from "../../LegalPage";

export const metadata: Metadata = {
  title: "账号注销",
  description: "申请注销东财之影账号并删除个人数据。",
};

export default function DeleteAccountPage() {
  return (
    <LegalPage eyebrow="ACCOUNT" title="账号注销说明">
      <p>
        微信账号体系正式开放后，用户可以注销东财之影账号。当前审核和测试阶段尚未创建正式微信用户，不会因为访问此页面自动产生账号。
      </p>

      <h2>如何申请</h2>
      <p>
        正式功能上线后，优先使用“我的 → 账号与安全 →
        注销账号”提交申请。在该入口上线前，可以从注册账号常用邮箱发送申请至{" "}
        <a href="mailto:2450256851@qq.com?subject=东财之影账号注销申请">
          2450256851@qq.com
        </a>
        ，邮件标题注明“东财之影账号注销申请”。
      </p>

      <h2>注销前确认</h2>
      <ul>
        <li>所有设备将退出登录。</li>
        <li>个人课表、日程、作业、收藏和偏好将无法恢复。</li>
        <li>白果云、图书馆和模型密钥等外部连接将被解除并删除。</li>
        <li>与账号关联的分享链接将失效。</li>
      </ul>

      <h2>处理时间</h2>
      <p>
        收到申请后，我们会进行必要的身份核验并在十五个工作日内处理。为防止他人恶意注销，不会要求用户通过邮件发送微信密码、学校密码、Cookie 或第三方密钥。
      </p>

      <h2>注销后的保留</h2>
      <p>
        完成注销后，个人内容将删除或匿名化。法律法规要求保留的安全与审计记录会在规定期限内隔离保存，到期后删除。
      </p>
    </LegalPage>
  );
}
