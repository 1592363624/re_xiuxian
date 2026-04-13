import re

with open('/workspace/diff.txt', 'r') as f:
    diff_content = f.read()

files = diff_content.split('diff --git')
for file_diff in files[1:]:
    lines = file_diff.strip().split('\n')
    file_name = lines[0].split(' b/')[-1]
    
    adds = [l for l in lines if l.startswith('+') and not l.startswith('+++')]
    dels = [l for l in lines if l.startswith('-') and not l.startswith('---')]
    
    print(f"File: {file_name}")
    print(f"  Added lines: {len(adds)}")
    print(f"  Deleted lines: {len(dels)}")
    if len(adds) > 0:
        print("  Additions sample:")
        for a in adds[:5]:
            print("    " + a[:100])
    if len(dels) > 0:
        print("  Deletions sample:")
        for d in dels[:5]:
            print("    " + d[:100])
    print()
