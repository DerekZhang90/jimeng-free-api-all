import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import {
  generateImages,
  generateImageComposition,
  DEFAULT_MODEL as DEFAULT_IMAGE_MODEL,
} from "@/api/controllers/images.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";
import taskStore from "@/lib/task-store.ts";
import taskQueue from "@/lib/task-queue.ts";
import { sendWebhook } from "@/lib/webhook.ts";
import logger from "@/lib/logger.ts";

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      // 检查是否使用了不支持的参数
      const unsupportedParams = ['size', 'width', 'height'];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制图像尺寸。`);
      }

      request
        .validate("body.model", v => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", _.isString)
        .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
        .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
        .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("body.async", v => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.callback_url", v => _.isUndefined(v) || (_.isString(v) && v.startsWith("http")))
        .validate("headers.authorization", _.isString);

      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);
      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
        response_format,
      } = request.body;
      const finalModel = _.defaultTo(model, DEFAULT_IMAGE_MODEL);

      const responseFormat = _.defaultTo(response_format, "url");

      // ====== 异步模式 ======
      if (request.body.async === true) {
        const task = await taskStore.create({
          type: "image",
          status: "pending",
          callback_url: request.body.callback_url,
          model: finalModel,
          prompt,
        });

        taskQueue.enqueue(task.id, async () => {
          try {
            await taskStore.update(task.id, { status: "processing", progress: "生成中" });
            const imageUrls = await generateImages(
              finalModel,
              prompt,
              {
                ratio,
                resolution,
                sampleStrength,
                negativePrompt,
                intelligentRatio,
              },
              token
            );

            let data = [];
            if (responseFormat === "b64_json") {
              data = (await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({
                b64_json: b64,
              }));
            } else {
              data = imageUrls.map((url) => ({ url }));
            }

            await taskStore.update(task.id, {
              status: "completed",
              result: { created: util.unixTimestamp(), data },
              completed_at: Math.floor(Date.now() / 1000),
            });
          } catch (err: any) {
            logger.error(`[Async] 图片生成任务 ${task.id} 失败: ${err.message}`);
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
      const imageUrls = await generateImages(
        finalModel,
        prompt,
        {
          ratio,
          resolution,
          sampleStrength,
          negativePrompt,
          intelligentRatio,
        },
        token
      );

      let data = [];
      if (responseFormat === "b64_json") {
        data = (await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({
          b64_json: b64,
        }));
      } else {
        data = imageUrls.map((url) => ({ url }));
      }
      return {
        created: util.unixTimestamp(),
        data,
      };
    },

    // 图片合成路由（图生图）
    "/compositions": async (request: Request) => {
      // 检查是否使用了不支持的参数
      const unsupportedParams = ['size', 'width', 'height'];
      const bodyKeys = Object.keys(request.body);
      const foundUnsupported = unsupportedParams.filter(param => bodyKeys.includes(param));

      if (foundUnsupported.length > 0) {
        throw new Error(`不支持的参数: ${foundUnsupported.join(', ')}。请使用 ratio 和 resolution 参数控制图像尺寸。`);
      }

      const contentType = request.headers['content-type'] || '';
      const isMultiPart = contentType.startsWith('multipart/form-data');

      if (isMultiPart) {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || (typeof v === 'string' && (v === 'true' || v === 'false')) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("body.async", v => _.isUndefined(v) || _.isBoolean(v) || v === "true" || v === "false")
          .validate("body.callback_url", v => _.isUndefined(v) || (_.isString(v) && v.startsWith("http")))
          .validate("headers.authorization", _.isString);
      } else {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.images", _.isArray)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("body.async", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.callback_url", v => _.isUndefined(v) || (_.isString(v) && v.startsWith("http")))
          .validate("headers.authorization", _.isString);
      }

      let images: (string | Buffer)[] = [];
      if (isMultiPart) {
        const rawFiles: any = request.files;
        const imageFiles = Array.isArray(rawFiles)
          ? rawFiles
          : rawFiles?.images
            ? (Array.isArray(rawFiles.images) ? rawFiles.images : [rawFiles.images])
            : [];

        if (imageFiles.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (imageFiles.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        images = imageFiles.map((file: any, index: number) => {
          if (!file?.filepath) {
            throw new Error(`第 ${index + 1} 个上传文件无效`);
          }
          return fs.readFileSync(file.filepath);
        });
      } else {
        const bodyImages = request.body.images;
        if (!bodyImages || bodyImages.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (bodyImages.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        bodyImages.forEach((image: any, index: number) => {
          if (!_.isString(image) && !_.isObject(image)) {
            throw new Error(`图片 ${index + 1} 格式不正确：应为URL字符串或包含url字段的对象`);
          }
          if (_.isObject(image) && !image.url) {
            throw new Error(`图片 ${index + 1} 缺少url字段`);
          }
        });
        images = bodyImages.map((image: any) => _.isString(image) ? image : image.url);
      }

      // refresh_token切分
      const tokens = tokenSplit(request.headers.authorization);
      // 随机挑选一个refresh_token
      const token = _.sample(tokens);

      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
        response_format,
      } = request.body;
      const finalModel = _.defaultTo(model, DEFAULT_IMAGE_MODEL);

      // 如果是 multipart/form-data，需要将字符串转换为数字和布尔值
      const finalSampleStrength = isMultiPart && typeof sampleStrength === 'string'
        ? parseFloat(sampleStrength)
        : sampleStrength;

      const finalIntelligentRatio = isMultiPart && typeof intelligentRatio === 'string'
        ? intelligentRatio === 'true'
        : intelligentRatio;

      const responseFormat = _.defaultTo(response_format, "url");

      const isAsync = isMultiPart && typeof request.body.async === "string"
        ? request.body.async === "true"
        : request.body.async === true;

      // ====== 异步模式 ======
      if (isAsync) {
        const task = await taskStore.create({
          type: "composition",
          status: "pending",
          callback_url: request.body.callback_url,
          model: finalModel,
          prompt,
        });

        taskQueue.enqueue(task.id, async () => {
          try {
            await taskStore.update(task.id, { status: "processing", progress: "生成中" });
            const resultUrls = await generateImageComposition(
              finalModel,
              prompt,
              images,
              {
                ratio,
                resolution,
                sampleStrength: finalSampleStrength,
                negativePrompt,
                intelligentRatio: finalIntelligentRatio,
              },
              token
            );

            let data = [];
            if (responseFormat === "b64_json") {
              data = (await Promise.all(resultUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({
                b64_json: b64,
              }));
            } else {
              data = resultUrls.map((url) => ({ url }));
            }

            await taskStore.update(task.id, {
              status: "completed",
              result: {
                created: util.unixTimestamp(),
                data,
                input_images: images.length,
                composition_type: "multi_image_synthesis",
              },
              completed_at: Math.floor(Date.now() / 1000),
            });
          } catch (err: any) {
            logger.error(`[Async] 图生图任务 ${task.id} 失败: ${err.message}`);
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
      const resultUrls = await generateImageComposition(
        finalModel,
        prompt,
        images,
        {
          ratio,
          resolution,
          sampleStrength: finalSampleStrength,
          negativePrompt,
          intelligentRatio: finalIntelligentRatio,
        },
        token
      );

      let data = [];
      if (responseFormat === "b64_json") {
        data = (await Promise.all(resultUrls.map((url) => util.fetchFileBASE64(url)))).map((b64) => ({
          b64_json: b64,
        }));
      } else {
        data = resultUrls.map((url) => ({ url }));
      }

      return {
        created: util.unixTimestamp(),
        data,
        input_images: images.length,
        composition_type: "multi_image_synthesis",
      };
    },
  },
};
