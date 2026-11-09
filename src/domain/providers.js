import { fail } from "./errors.js";

// Provider presets describe connection rules, never account permissions or
// successful vendor acceptance. Keep unverified capabilities unknown.
export const PROVIDERS = Object.freeze(
  [
    {
      id: "minio",
      name: "MinIO",
      location: "us-east-1",
      pathStyle: true,
      tags: "available",
      hint: "填写自建服务的完整Endpoint和实际区域；默认Path style。",
      credentialHint: "使用MinIO Access Key / Secret Key。",
    },
    {
      id: "s3",
      name: "通用 S3",
      location: "us-east-1",
      pathStyle: false,
      tags: "unknown",
      hint: "填写服务方提供的S3 Endpoint、签名区域及寻址方式；兼容范围按实际服务判断。",
      credentialHint: "使用该服务的S3凭证。",
    },
    {
      id: "aws",
      name: "Amazon S3",
      location: "us-east-1",
      pathStyle: false,
      tags: "available",
      hint: "普通S3桶；按所在Region选择域名，中国区使用amazonaws.com.cn。目录桶/Access Points不在当前范围。",
      credentialHint:
        "使用AWS Access Key / Secret Key，可填STS Session Token。",
    },
    {
      id: "oss",
      name: "阿里云 OSS（原生）",
      location: "cn-shanghai",
      pathStyle: false,
      tags: "available",
      hint: "使用原生OSS Endpoint：oss-地域.aliyuncs.com，桶名单独填写；不使用s3.oss兼容域名。原生V4签名，云账号尚未实机验收。",
      credentialHint:
        "Access Key填AccessKey ID，Secret Key填AccessKey Secret；临时SecurityToken填Session Token。",
    },
    {
      id: "obs",
      name: "华为云 OBS（原生）",
      location: "cn-north-4",
      pathStyle: false,
      tags: "available",
      hint: "使用原生OBS Endpoint：obs.地域.myhuaweicloud.com，桶名单独填写；仅支持虚拟主机寻址，禁止Path style。云账号尚未实机验收。",
      credentialHint:
        "使用华为云Access Key ID / Secret Access Key；临时SecurityToken填Session Token。",
    },
    {
      id: "aliyun",
      name: "阿里云 OSS（旧版/S3兼容）",
      location: "cn-hangzhou",
      pathStyle: false,
      tags: "unsupported",
      hint: "使用S3兼容Endpoint：s3.oss-地域.aliyuncs.com，采用虚拟主机寻址。S3兼容接口不开放本工具的对象标签操作。",
      credentialHint:
        "使用阿里云AccessKey ID / AccessKey Secret，可填STS SecurityToken。",
    },
    {
      id: "cos-native",
      name: "腾讯云 COS（原生）",
      location: "ap-guangzhou",
      pathStyle: false,
      tags: "unknown",
      hint: "使用原生COS Endpoint：cos.地域.myqcloud.com；桶名称须包含-APPID后缀。云账号尚未实机验收。",
      credentialHint:
        "使用提供商Access Key / Secret Key；临时Token填Session Token。",
    },
    {
      id: "cos",
      name: "腾讯云 COS（旧版/S3兼容）",
      location: "ap-guangzhou",
      pathStyle: false,
      tags: "unknown",
      hint: "Endpoint使用cos.地域.myqcloud.com；桶名称须包含-APPID后缀。",
      credentialHint:
        "Access Key填SecretId，Secret Key填SecretKey；临时Token填Session Token。",
    },
    {
      id: "tos-native",
      name: "火山引擎 TOS（原生）",
      location: "cn-beijing",
      pathStyle: false,
      tags: "unknown",
      hint: "使用原生TOS Endpoint：tos-地域.volces.com，不使用tos-s3兼容域名。云账号尚未实机验收。",
      credentialHint:
        "使用提供商Access Key / Secret Key；临时Token填Session Token。",
    },
    {
      id: "tos",
      name: "火山引擎 TOS（旧版/S3兼容）",
      location: "cn-beijing",
      pathStyle: false,
      tags: "unknown",
      hint: "使用tos-s3-地域.volces.com，与TOS原生Endpoint区分；内网域名需手动填写。",
      credentialHint: "使用火山引擎IAM AccessKey ID / Secret Access Key。",
    },
    {
      id: "qiniu",
      name: "七牛云 Kodo（S3）",
      location: "cn-east-1",
      pathStyle: true,
      tags: "unknown",
      hint: "默认桶填写控制台中的S3空间名，可能与普通空间名不同；S3域名需要签名，不能当作匿名公开地址。",
      credentialHint: "使用七牛AccessKey / SecretKey。",
    },
    {
      id: "r2",
      name: "Cloudflare R2",
      location: "auto",
      pathStyle: true,
      tags: "unsupported",
      hint: "需要32位Account ID；区域auto，使用账户S3 API域名。API Token须换成R2 S3 Access Key，r2.dev/自定义域名仅用于公开访问。当前S3 API不支持对象标签。",
      credentialHint:
        "使用R2 S3 API Access Key ID / Secret Access Key，不填Cloudflare Global API Key。",
    },
    {
      id: "b2",
      name: "Backblaze B2",
      location: "us-west-004",
      pathStyle: true,
      tags: "unsupported",
      hint: "服务地域从桶详情Endpoint获取。使用S3 Application Key；B2不支持对象标签，GetObjectTagging返回空不代表可编辑。",
      credentialHint:
        "Access Key填keyID，Secret Key填applicationKey；不要使用主Application Key。",
    },
    {
      id: "spaces",
      name: "DigitalOcean Spaces",
      location: "nyc3",
      pathStyle: false,
      tags: "unknown",
      hint: "服务地域如nyc3/sgp1；生成区域Endpoint并使用us-east-1签名区域。CDN域名不能代替S3 API Endpoint。",
      credentialHint:
        "使用Spaces Access Key / Secret Key，不填DigitalOcean个人API Token。",
    },
    {
      id: "wasabi",
      name: "Wasabi",
      location: "us-east-1",
      pathStyle: true,
      tags: "unknown",
      hint: "选择桶所在服务地域，Endpoint为s3.地域.wasabisys.com；保留/最短存储等限制以账户策略为准。",
      credentialHint: "使用Wasabi Access Key / Secret Key。",
    },
  ].map((provider) =>
    Object.freeze({
      ...provider,
      versions: provider.id === "r2" ? "unsupported" : "unknown",
      // Do not trust an unverified service to honor If-None-Match on every
      // upload path (single PUT and multipart completion). Preserve the v1 routes.
      requireOverwriteConsent: !["minio", "s3", "aws"].includes(provider.id),
    }),
  ),
);

// Legacy identities remain readable for saved profiles/tasks, but cannot be
// selected for a new connection or another provider's profile.
export function getSelectableProviders(currentProvider) {
  return PROVIDERS.filter(
    (provider) =>
      !["aliyun", "cos", "tos"].includes(provider.id) ||
      provider.id === currentProvider,
  );
}

export function getProvider(id) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) fail("INVALID_INPUT", "提供商无效。");
  return provider;
}

export function assertObjectTagsSupported(provider = "s3") {
  const p = getProvider(provider);
  if (p.tags === "unsupported")
    fail(
      "UNSUPPORTED",
      `${p.name}的S3接入不支持对象标签，请使用提供商支持的管理方式。`,
    );
}

export function assertObjectVersionsSupported(provider = "s3") {
  const p = getProvider(provider);
  if (p.versions === "unsupported")
    fail("UNSUPPORTED", `${p.name}的S3接入不支持对象版本管理。`);
}

export function assertUploadPolicy(provider = "s3", overwrite = false) {
  if (getProvider(provider).requireOverwriteConsent && !overwrite)
    fail(
      "NO_OVERWRITE_UNVERIFIED",
      "此提供商尚未验证完整的原子不覆盖上传，请核对目标后明确允许覆盖再上传。",
    );
}

export function buildProviderConfig(id, { location, accountId } = {}) {
  const p = getProvider(id);
  if (["minio", "s3"].includes(id))
    fail(
      "MANUAL_ENDPOINT_REQUIRED",
      "自建/通用S3请手动填写Endpoint和签名区域。",
    );
  const place = location ?? p.location;
  if (
    typeof place !== "string" ||
    place.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(place)
  )
    fail("INVALID_INPUT", "服务地域格式无效，请填写提供商地域代码。");
  let endpoint,
    region = place;
  switch (id) {
    case "aws":
      endpoint = `https://s3.${place}.amazonaws.com${place.startsWith("cn-") ? ".cn" : ""}`;
      break;
    case "oss":
      endpoint = `https://oss-${place}.aliyuncs.com`;
      break;
    case "obs":
      endpoint = `https://obs.${place}.myhuaweicloud.com`;
      break;
    case "aliyun":
      endpoint = `https://s3.oss-${place}.aliyuncs.com`;
      break;
    case "cos-native":
    case "cos":
      endpoint = `https://cos.${place}.myqcloud.com`;
      break;
    case "tos-native":
      endpoint = `https://tos-${place}.volces.com`;
      break;
    case "tos":
      endpoint = `https://tos-s3-${place}.volces.com`;
      break;
    case "qiniu":
      endpoint = `https://s3.${place}.qiniucs.com`;
      break;
    case "r2":
      if (
        place !== "auto" ||
        typeof accountId !== "string" ||
        !/^[a-f0-9]{32}$/i.test(accountId)
      )
        fail(
          "INVALID_INPUT",
          "R2需填写32位十六进制Account ID，区域使用auto；特殊辖区Endpoint请手动填写。",
        );
      endpoint = `https://${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
      break;
    case "b2":
      endpoint = `https://s3.${place}.backblazeb2.com`;
      break;
    case "spaces":
      endpoint = `https://${place}.digitaloceanspaces.com`;
      region = "us-east-1";
      break;
    case "wasabi":
      endpoint = `https://s3.${place}.wasabisys.com`;
      break;
  }
  return { endpoint, region, forcePathStyle: p.pathStyle };
}

// Draft-only transformation. Persisting this result remains an explicit caller
// action; existing profiles and their S3 checkpoints are never migrated here.
export function migrateAliyunConnection(connection) {
  if (connection?.provider !== "aliyun")
    fail("INVALID_INPUT", "仅旧版阿里云S3连接可迁移为原生OSS。");
  const canonical =
    /^(https?:\/\/)s3\.(oss-[a-z0-9]+(?:-[a-z0-9]+)*\.aliyuncs\.com)(\/?)$/i;
  const converted = canonical.test(connection.endpoint);
  return {
    connection: {
      ...connection,
      provider: "oss",
      endpoint: converted
        ? connection.endpoint.replace(canonical, "$1$2$3")
        : connection.endpoint,
      forcePathStyle: false,
    },
    converted,
    notice: converted
      ? "已将标准S3兼容域名转换为原生OSS域名。保存后才生效；原S3上传续传记录不会迁移。"
      : "自定义Endpoint已保留，请核对原生OSS地址及区域后保存。保存后才生效；原S3上传续传记录不会迁移。",
  };
}

// Explicitly transforms a draft only. No credentials or saved profiles change.
export function migrateLegacyConnection(connection) {
  if (connection?.provider === "aliyun")
    return migrateAliyunConnection(connection);
  const targets = {
    cos: {
      id: "cos-native",
      name: "COS",
      canonical:
        /^(https?:\/\/)(cos\.[a-z0-9]+(?:-[a-z0-9]+)*\.myqcloud\.com)(\/?)$/i,
    },
    tos: {
      id: "tos-native",
      name: "TOS",
      canonical:
        /^(https?:\/\/)tos-s3-([a-z0-9]+(?:-[a-z0-9]+)*\.volces\.com)(\/?)$/i,
    },
  };
  const target = targets[connection?.provider];
  if (!target) fail("INVALID_INPUT", "仅旧版S3兼容连接可迁移为对应原生接入。");
  const converted = target.canonical.test(connection.endpoint);
  const endpoint =
    converted && connection.provider === "tos"
      ? connection.endpoint.replace(target.canonical, "$1tos-$2$3")
      : connection.endpoint;
  return {
    connection: {
      ...connection,
      provider: target.id,
      endpoint,
      forcePathStyle: false,
    },
    converted,
    notice:
      (converted
        ? `已核对标准原生${target.name}域名。`
        : `自定义Endpoint已保留，请核对原生${target.name}地址及区域。`) +
      "保存后才生效；原S3上传续传记录不会迁移。",
  };
}
