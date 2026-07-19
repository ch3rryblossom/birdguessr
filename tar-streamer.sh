tar -xOf ebd_relAug-2025.tar ebd_relAug-2025.txt.gz | pv -s 200G | gzip -dc | \
awk -F $'\t' 'NR==FNR {valid[$1]; next} FNR==1 {print; next} ($35 in valid) {print}' valid_sampling_IDs.txt - \
  | gzip -c > filtered_ebd.txt.gz
