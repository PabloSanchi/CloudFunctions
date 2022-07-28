# ☁️ Cloud functions SPACE CHESS
cloud functions help us to transfer data between the database and the satellite. 

If it is the Earth(🌎) turn, at minute 0 every day the cloud functions send the most voted movement to the ground station(📡) via SFTP, In case there are no votes an AI will play instead.

Lastly, the other cloud function tries to fetch the board status with the satellite(🛰️) move so we can update the database and see the current status.


## Warning ⚠️
If you want to use these functions schema so you can code something similar for your project, keep in mind that you must set:
```javascript
const config = {...}
```

just like the following one:

```javascript
const config = {
  host: ENDPOINT
  username: USERNAME,
  password: PASSWORD,
}
```

We recommend the use of environment variables.