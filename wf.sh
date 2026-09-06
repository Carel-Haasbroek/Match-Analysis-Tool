### block
if [[ "$GITHUB_REF" != refs/tags/* ]]; then
  echo "This has to run on a tag, not on $GITHUB_REF_NAME."
  echo "Actions -> Release -> Run workflow -> choose the tag in the dropdown."
  exit 1
fi
tag="${GITHUB_REF_NAME#v}"
pkg="$(node -p "require('./package.json').version")"
if [ "$tag" != "$pkg" ]; then
  echo "tag $GITHUB_REF_NAME does not match package.json version $pkg"
  exit 1
fi
echo "releasing $pkg"

### block
shopt -s nullglob
setup=(dist/*Setup*.exe)
portable=(dist/*portable*.exe)
if [ ${#setup[@]} -ne 1 ] || [ ${#portable[@]} -ne 1 ]; then
  echo "expected exactly one installer and one portable exe. dist holds:"
  ls -l dist/*.exe 2>/dev/null || echo "  no exe at all - the build produced nothing"
  exit 1
fi
ls -lh "${setup[0]}" "${portable[0]}"
if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
  gh release upload "$GITHUB_REF_NAME" "${setup[0]}" "${portable[0]}" --clobber
else
  gh release create "$GITHUB_REF_NAME" "${setup[0]}" "${portable[0]}" \
    --title "$GITHUB_REF_NAME" --generate-notes
fi

### block
gh release view "$GITHUB_REF_NAME" --json assets \
  --jq '.assets[] | "  \(.name)  \(.size) bytes"' || echo "no release to read"
