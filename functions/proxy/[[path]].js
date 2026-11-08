const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (url.pathname === "/proxy/health") {
    return json({
      status: "healthy",
      platform: "Cloudflare Pages Functions",
      timestamp: new Date().toISOString(),
    });
  }

  const target = decodeURIComponent(url.pathname.replace(/^\/proxy\//, ""));
  if (!/^https?:\/\//i.test(target)) {
    return json(
      { error: "Target URL is required", usage: "/proxy/{encoded-target-url}" },
      400
    );
  }

  try {
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      const lower = key.toLowerCase();
      if (["host", "cf-ray", "cf-connecting-ip", "cf-visitor",      
           "x-forwarded-proto", "x-real-ip", "cf-ipcountry"].includes(lower)    
         ) 
        continue;     
      headers.set(key, value);  
    }
headers.set(       "User-Agent",    
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +   
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"     );  
    headers.set("Accept", "*/*");   
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");   
    headers.set("Cache-Control", "no-cache");
const init = {       method: request.method,    
              headers,   
              redirect: "follow",    
              signal: AbortSignal.timeout(30000), 
             };  
    if (request.method !== "GET" && request.method !== "HEAD") 
    {    
      init.body = request.body;  
    }
const upstream = await fetch(target, init);   
    const responseHeaders = new Headers();   
    for (const [key, value] of upstream.headers)
    {  
      if (       
        ["content-encoding", "content-length", "transfer-encoding"]   
        .includes(key.toLowerCase()
                 )  
      )
        continue;    
      responseHeaders.set(key, value);  
    }   
    for (const [key, value] of Object.entries(CORS)) {   
      responseHeaders.set(key, value);   
    }   
    responseHeaders.set("Cache-Control", "public, max-age=300");
return new Response(upstream.body,
                    {   
                      status: upstream.status,   
                      statusText: upstream.statusText,   
                      headers: responseHeaders,     });  
  } 
  catch (error) {  
    return json(     
      { error: "Proxy request failed", message: error.message, targetUrl: target },   
      502   
    );   
  } 
}
