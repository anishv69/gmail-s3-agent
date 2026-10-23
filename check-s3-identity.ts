import { createS3Client, getS3Bucket } from './src/lib/s3-client';
import { GetBucketAclCommand, GetBucketPolicyCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

async function run(){
  const s3 = createS3Client();
  const bucket = getS3Bucket();
  try{
    // Head bucket
    try{ await s3.send(new HeadBucketCommand({ Bucket: bucket })); console.log('headBucket: ok'); }catch(e:any){ console.error('headBucket_error', e.name || e.Code || e.message); }

    // get ACL
    try{ const acl = await s3.send(new GetBucketAclCommand({ Bucket: bucket })); console.log('getBucketAcl: ok', { grants: (acl.Grants||[]).length, owner: !!acl.Owner }); }catch(e:any){ console.error('getBucketAcl_error', e.name || e.Code || e.message); }

    // get policy
    try{ const policy = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket })); console.log('getBucketPolicy: ok (policy length)', policy.Policy?.length || 0); }catch(e:any){ console.error('getBucketPolicy_error', e.name || e.Code || e.message); }
  }finally{ s3.destroy(); }
}
run().catch(e=>{ console.error('fatal', e); process.exitCode=1 });
