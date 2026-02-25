import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import {
  generateVideo,
  generateSeedanceVideo,
  isSeedanceModel,
  DEFAULT_MODEL,
} from "@/api/controllers/videos.ts";
import util from "@/lib/util.ts";
import taskStore from "@/lib/task-store.ts";
import taskQueue from "@/lib/task-queue.ts";
import { sendWebhook } from "@/lib/webhook.ts";
import logger from "@/lib/logger.ts";

export default {
  prefix: "/v1/videos",

  post: {
    "/generations": async (request: Request) => {
      // 检查是否使用了不支持的参数
      const unsupportedParams = ["size", "width", "height"];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter((param) => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(", ")}。请使用 ratio 和 resolution 参数控制视频尺寸。`);
      }

      const contentType = request.headers["content-type"] || "";
      const isMultiPart = contentType.startsWith("multipart/form-data");

      request
        .validate("body.model", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.ratio", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.duration", (v) => {
          if (_.isUndefined(v)) return true;
          // 对于 multipart/form-data，允许字符串类型的数字
          if (isMultiPart && typeof v === "string") {
            const num = parseInt(v);
            // Seedance 支持 4-15 秒连续范围，普通视频支持 5 或 10 秒
            return (num >= 4 && num <= 15) || num === 5 || num === 10;
          }
          // 对于 JSON，要求数字类型
          // Seedance 支持 4-15 秒连续范围，普通视频支持 5 或 10 秒
          return _.isFinite(v) && ((v >= 4 && v <= 15) || v === 5 || v === 10);
        })
        .validate("body.file_paths", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.filePaths", (v) => _.isUndefined(v) || _.isArray(v))
        .validate("body.response_format", (v) => _.isUndefined(v) || _.isString(v))
        .validate("body.async", (v) => _.isUndefined(v) || _.isBoolean(v) || v === "true" || v === "false")
        .validate("body.callback_url", (v) => _.isUndefined(v) || (_.isString(v) && v.startsWith("http")))
        .validate("headers.authorization", _.isString);

      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);

      const {
        model = DEFAULT_MODEL,
        prompt,
        ratio = "1:1",
        resolution = "720p",
        duration = 5,
        file_paths = [],
        filePaths = [],
        response_format = "url",
      } = request.body;

      // 如果是 multipart/form-data，需要将字符串转换为数字
      const finalDuration = isMultiPart && typeof duration === "string" ? parseInt(duration) : duration;

      // 兼容两种参数名格式：file_paths 和 filePaths
      const finalFilePaths = filePaths.length > 0 ? filePaths : file_paths;

      // 处理 multipart 中的 async 参数（字符串转布尔）
      const isAsync =
        isMultiPart && typeof request.body.async === "string"
          ? request.body.async === "true"
          : request.body.async === true;

      const generateAndFormat = async () => {
        // 根据模型类型选择不同的生成函数
        let videoUrl: string;
        if (isSeedanceModel(model)) {
          // Seedance 默认时长为 4 秒，默认比例为 4:3
          const seedanceDuration = finalDuration === 5 ? 4 : finalDuration;
          const seedanceRatio = ratio === "1:1" ? "4:3" : ratio;

          videoUrl = await generateSeedanceVideo(
            model,
            prompt,
            {
              ratio: seedanceRatio,
              resolution,
              duration: seedanceDuration,
              filePaths: finalFilePaths,
              files: request.files,
            },
            token
          );
        } else {
          videoUrl = await generateVideo(
            model,
            prompt,
            {
              ratio,
              resolution,
              duration: finalDuration,
              filePaths: finalFilePaths,
              files: request.files,
            },
            token
          );
        }

        if (response_format === "b64_json") {
          const videoBase64 = await util.fetchFileBASE64(videoUrl);
          return {
            created: util.unixTimestamp(),
            data: [
              {
                b64_json: videoBase64,
                revised_prompt: prompt,
              },
            ],
          };
        }

        return {
          created: util.unixTimestamp(),
          data: [
            {
              url: videoUrl,
              revised_prompt: prompt,
            },
          ],
        };
      };

      // ====== 异步模式 ======
      if (isAsync) {
        const task = await taskStore.create({
          type: "video",
          status: "pending",
          callback_url: request.body.callback_url,
          model,
          prompt,
        });

        taskQueue.enqueue(task.id, async () => {
          try {
            await taskStore.update(task.id, { status: "processing", progress: "生成中" });
            const resultData = await generateAndFormat();
            await taskStore.update(task.id, {
              status: "completed",
              result: resultData,
              completed_at: Math.floor(Date.now() / 1000),
            });
          } catch (err: any) {
            logger.error(`[Async] 视频生成任务 ${task.id} 失败: ${err.message}`);
            await taskStore.update(task.id, {
              status: "failed",
              error: err.message,
              completed_at: Math.floor(Date.now() / 1000),
            });
          }

          const finalTask = await taskStore.get(task.id);
          if (finalTask?.callback_url) {
            await sendWebhook(finalTask.callback_url, finalTask);
          }
        });

        return { task_id: task.id, status: "pending" };
      }

      // ====== 同步模式（原有逻辑） ======
      return await generateAndFormat();
    },
  },
};
